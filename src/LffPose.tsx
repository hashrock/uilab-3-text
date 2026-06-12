import { useEffect, useRef, useState } from 'react'
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision'
import { parseLines, type Font } from './lib/lff/parser'

const FONT_URL = `${import.meta.env.BASE_URL}kst32b.lff`
const WASM_URL =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm'
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task'

type Node = { x: number; y: number }

// One of the five "human joints" a glyph can adopt. The role is chosen purely
// from where a terminal sits in the glyph box (top-center = head, the four
// corners = the four limbs), then bound to the matching body landmark.
type Role = 'head' | 'leftHand' | 'rightHand' | 'leftFoot' | 'rightFoot'

// A "limb" is the terminal branch leading out to one tip: the chain of nodes
// from a junction (the base, kept fixed) out to the tip. The branch keeps its
// rest segment lengths and is bent — not stretched — by an angle taken from the
// matching body limb, so the glyph body is preserved and only the terminal
// curls. At a neutral pose the bend is zero and the glyph is exactly at rest.
type Branch = {
  role: Role
  base: number // chain[0], stays at rest
  chain: number[] // node indices, base -> tip
  segRest: { x: number; y: number }[] // rest segment vectors, base -> tip
  bend: number // current total bend angle (radians), distributed along chain
  // For arms: the limb angle captured the first frame the pose is recognized.
  // Bend is driven by the deviation from this calibrated baseline (so a held
  // pose reads as zero, and returning to it un-bends the limb).
  baseAngle: number
  inited: boolean
}

type CharInstance = {
  letter: string
  rest: Node[] // immutable rest positions
  nodes: Node[] // live positions (rest + branch offsets)
  strokes: [number, number][]
  branches: Branch[]
  cx: number // rest bbox center
  cy: number
  height: number // rest bbox height
}

function isHankaku(s: string) {
  return /^[\w ',&]+$/.test(s)
}

// MediaPipe Pose landmark indices. "left"/"right" here are the subject's own
// sides; because we mirror the webcam, the role mapping swaps them so the
// glyph's left limb follows the hand that appears on the viewer's left.
const POSE = {
  nose: 0,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
}

// role -> landmark index (after horizontal mirror). leftHand follows the
// subject's right wrist so it lands on the viewer's left, and so on.
const ROLE_LANDMARK: Record<Role, number> = {
  head: POSE.nose,
  leftHand: POSE.rightWrist,
  rightHand: POSE.leftWrist,
  leftFoot: POSE.rightAnkle,
  rightFoot: POSE.leftAnkle,
}

// Proximal joint for each limb's angle (distal = ROLE_LANDMARK). The limb angle
// is measured from this joint to the tip landmark. head uses the shoulder
// midpoint (computed separately, marked -1).
const ROLE_PROX: Record<Role, number> = {
  head: -1,
  leftHand: POSE.rightElbow,
  rightHand: POSE.leftElbow,
  leftFoot: POSE.rightKnee,
  rightFoot: POSE.leftKnee,
}

// Neutral limb direction (radians, screen space with y pointing down): arms and
// legs hang downward (+y), the head points up (-y). The glyph only bends by how
// far the live limb deviates from this neutral, so a relaxed pose = rest glyph.
const ROLE_NEUTRAL: Record<Role, number> = {
  head: -Math.PI / 2,
  leftHand: Math.PI / 2,
  rightHand: Math.PI / 2,
  leftFoot: Math.PI / 2,
  rightFoot: Math.PI / 2,
}

// Per-role bend multiplier: the neck reads small angles, so amplify it; arms
// swing wide, so damp them.
const ROLE_GAIN: Record<Role, number> = {
  head: 4,
  leftHand: 0.5,
  rightHand: 0.5,
  leftFoot: 1,
  rightFoot: 1,
}

function normAngle(a: number) {
  while (a > Math.PI) a -= 2 * Math.PI
  while (a < -Math.PI) a += 2 * Math.PI
  return a
}

// Signed deviation of a body limb from its neutral hang, in [-π, π]. Returns 0
// when the relevant landmarks are missing.
function limbDeviation(role: Role, pts: { x: number; y: number }[]) {
  const distal = pts[ROLE_LANDMARK[role]]
  if (!distal) return 0
  let px: number
  let py: number
  if (role === 'head') {
    const a = pts[POSE.leftShoulder]
    const b = pts[POSE.rightShoulder]
    if (!a || !b) return 0
    px = (a.x + b.x) / 2
    py = (a.y + b.y) / 2
  } else {
    const p = pts[ROLE_PROX[role]]
    if (!p) return 0
    px = p.x
    py = p.y
  }
  const angle = Math.atan2(distal.y - py, distal.x - px)
  return normAngle(angle - ROLE_NEUTRAL[role])
}

// Whether a limb's landmarks are confidently tracked. When a hand/foot leaves
// the frame MediaPipe still emits an (unreliable) estimate with low visibility,
// so we gate on it and let the un-tracked limb relax back to rest.
function limbVisible(
  role: Role,
  pts: { x: number; y: number; v: number }[],
  thr = 0.5,
) {
  const distal = pts[ROLE_LANDMARK[role]]
  if (!distal || distal.v < thr) return false
  if (role === 'head') {
    const a = pts[POSE.leftShoulder]
    const b = pts[POSE.rightShoulder]
    return !!a && !!b && a.v >= thr && b.v >= thr
  }
  const p = pts[ROLE_PROX[role]]
  return !!p && p.v >= thr
}

// Build a glyph into positioned nodes + a fixed stroke topology (same approach
// as LffStatic), then tag five terminal branches as the human limbs to bend.
function buildCharInstance(
  letter: string,
  font: Font,
  fontSize: number,
  offsetX: number,
): CharInstance {
  const s = fontSize / 10
  const subLen = Math.max(6, fontSize * 0.12)
  const indexByKey = new Map<string, number>()
  const nodes: Node[] = []
  const strokes: [number, number][] = []
  const degree = new Map<number, number>()

  const addEndpoint = (fx: number, fy: number): number => {
    const key = `${fx.toFixed(3)},${fy.toFixed(3)}`
    const existing = indexByKey.get(key)
    if (existing !== undefined) return existing
    const x = offsetX + fx * s
    const y = fy * -s + fontSize
    const idx = nodes.length
    nodes.push({ x, y })
    indexByKey.set(key, idx)
    return idx
  }

  for (const ln of font.info) {
    const a = addEndpoint(ln.x1, ln.y1)
    const b = addEndpoint(ln.x2, ln.y2)
    if (a === b) continue
    degree.set(a, (degree.get(a) ?? 0) + 1)
    degree.set(b, (degree.get(b) ?? 0) + 1)
    const ax = nodes[a].x
    const ay = nodes[a].y
    const bx = nodes[b].x
    const by = nodes[b].y
    const len = Math.hypot(bx - ax, by - ay)
    const segs = Math.max(1, Math.round(len / subLen))
    let prev = a
    for (let k = 1; k < segs; k++) {
      const t = k / segs
      const idx = nodes.length
      nodes.push({ x: ax + (bx - ax) * t, y: ay + (by - ay) * t })
      strokes.push([prev, idx])
      prev = idx
    }
    strokes.push([prev, b])
  }

  // Adjacency over the subdivided topology.
  const adj: number[][] = nodes.map(() => [])
  for (const [a, b] of strokes) {
    adj[a].push(b)
    adj[b].push(a)
  }
  const deg = (i: number) => adj[i].length

  // Glyph bbox (rest).
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const n of nodes) {
    if (n.x < minX) minX = n.x
    if (n.x > maxX) maxX = n.x
    if (n.y < minY) minY = n.y
    if (n.y > maxY) maxY = n.y
  }
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const height = Math.max(1, maxY - minY)

  // Candidate tips: prefer terminals (degree 1), fall back to all nodes. Each
  // role scores nodes by how well their position matches the body part, and a
  // tip is used for at most one role.
  const terminals = nodes.map((_, i) => i).filter((i) => deg(i) === 1)
  const pool = terminals.length >= 3 ? terminals : nodes.map((_, i) => i)

  const score: Record<Role, (n: Node) => number> = {
    // smaller is better
    head: (n) => (n.y - minY) + Math.abs(n.x - cx) * 0.6,
    leftHand: (n) => (n.x - minX) + (n.y - minY) * 0.8,
    rightHand: (n) => (maxX - n.x) + (n.y - minY) * 0.8,
    leftFoot: (n) => (n.x - minX) + (maxY - n.y) * 0.8,
    rightFoot: (n) => (maxX - n.x) + (maxY - n.y) * 0.8,
  }

  // How far (in nodes) a limb's influence can reach back from its tip.
  const reach = Math.max(2, Math.round((fontSize * 0.7) / subLen) + 1)

  // Walk inward from a tip collecting the branch chain, stopping at a junction,
  // another terminal, an already-claimed node, or the reach cap.
  const claimed = new Set<number>()
  const collectBranch = (tip: number): number[] => {
    const members = [tip]
    let prev = -1
    let cur = tip
    while (members.length < reach) {
      const nexts = adj[cur].filter((n) => n !== prev && !claimed.has(n))
      if (nexts.length !== 1) break
      const next = nexts[0]
      members.push(next)
      if (deg(next) >= 3 || deg(next) === 1) break // junction or other tip = base
      prev = cur
      cur = next
    }
    return members
  }

  const usedTip = new Set<number>()
  const branches: Branch[] = []
  const roles: Role[] = ['head', 'leftHand', 'rightHand', 'leftFoot', 'rightFoot']
  for (const role of roles) {
    let best = -1
    let bestScore = Infinity
    for (const i of pool) {
      if (usedTip.has(i)) continue
      const sc = score[role](nodes[i])
      if (sc < bestScore) {
        bestScore = sc
        best = i
      }
    }
    if (best < 0) continue
    usedTip.add(best)
    const tipChain = collectBranch(best) // tip -> base
    if (tipChain.length < 2) continue // need a segment to bend
    for (const n of tipChain) claimed.add(n)
    // Store base -> tip so the base node anchors the bend.
    const chain = [...tipChain].reverse()
    const base = chain[0]
    const segRest = chain.slice(1).map((node, i) => ({
      x: nodes[node].x - nodes[chain[i]].x,
      y: nodes[node].y - nodes[chain[i]].y,
    }))
    branches.push({
      role,
      base,
      chain,
      segRest,
      bend: 0,
      baseAngle: 0,
      inited: false,
    })
  }

  const rest = nodes.map((n) => ({ x: n.x, y: n.y }))

  return { letter, rest, nodes, strokes, branches, cx, cy, height }
}

type PoseFrame = {
  // mirrored, normalized [0,1] landmark positions (+ visibility)
  pts: { x: number; y: number; v: number }[]
}

// MediaPipe Pose skeleton connections (subject-side indices) for drawing bones.
const POSE_BONES: [number, number][] = [
  [11, 12], // shoulders
  [11, 13],
  [13, 15], // left arm
  [12, 14],
  [14, 16], // right arm
  [11, 23],
  [12, 24], // torso sides
  [23, 24], // hips
  [23, 25],
  [25, 27], // left leg
  [24, 26],
  [26, 28], // right leg
  [27, 31],
  [28, 32], // feet
]

export function LffPose() {
  const [text, setText] = useState('おどる')
  const [fontSize, setFontSize] = useState(150)
  const [kerning, setKerning] = useState(0)
  const [influence, setInfluence] = useState(1.0)
  const [scaleFactor, setScaleFactor] = useState(1.0)
  const [showCam, setShowCam] = useState(true)
  const [showBranches, setShowBranches] = useState(true)
  const [fontMap, setFontMap] = useState<Record<string, Font> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState('カメラ起動を待っています')
  const [focused, setFocused] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const instancesRef = useRef<CharInstance[]>([])
  const buildKeyRef = useRef('')
  const poseRef = useRef<PoseFrame | null>(null)
  const influenceRef = useRef(influence)
  const scaleRef = useRef(scaleFactor)
  const skewRef = useRef(0) // neck-driven global shear (radians)
  const [, setFrame] = useState(0)
  const rerender = () => setFrame((f) => (f + 1) % 1_000_000)

  useEffect(() => {
    influenceRef.current = influence
  }, [influence])
  useEffect(() => {
    scaleRef.current = scaleFactor
  }, [scaleFactor])

  // Load font.
  useEffect(() => {
    let cancelled = false
    fetch(FONT_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.text()
      })
      .then((src) => {
        if (cancelled) return
        const fonts = parseLines(src.split(/\r?\n/))
        const map: Record<string, Font> = {}
        for (const f of fonts) map[f.letter] = f
        setFontMap(map)
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const advance = fontSize - kerning
  // Glyphs occupy y in [0, fontSize]; the box matches that height and innerPad
  // supplies the breathing room (so the bottom isn't left empty).
  const boxH = fontSize

  // Layout / build glyph instances. Editing leading characters keeps later
  // unchanged instances so typing doesn't reset everyone's pose.
  useEffect(() => {
    if (!fontMap) return
    const buildKey = `${fontSize}|${kerning}`
    const fullRebuild = buildKey !== buildKeyRef.current
    buildKeyRef.current = buildKey
    const prev = instancesRef.current

    const target: { letter: string; offsetX: number; font: Font }[] = []
    let off = 0
    for (const ch of text) {
      const font = fontMap[ch]
      if (font) target.push({ letter: ch, offsetX: off * advance, font })
      off += isHankaku(ch) ? 0.5 : 1
    }

    const next: CharInstance[] = []
    let diverged = fullRebuild
    for (let i = 0; i < target.length; i++) {
      const t = target[i]
      if (!diverged && prev[i] && prev[i].letter === t.letter) {
        next.push(prev[i])
      } else {
        diverged = true
        next.push(buildCharInstance(t.letter, t.font, fontSize, t.offsetX))
      }
    }
    instancesRef.current = next
    rerender()
  }, [text, fontSize, kerning, advance, fontMap])

  // Camera + PoseLandmarker.
  useEffect(() => {
    let landmarker: PoseLandmarker | null = null
    let stream: MediaStream | null = null
    let raf = 0
    let cancelled = false
    let lastVideoTime = -1

    const init = async () => {
      try {
        setStatus('カメラを起動中…')
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480 },
          audio: false,
        })
        if (cancelled) return
        const video = videoRef.current!
        video.srcObject = stream
        await video.play()

        setStatus('ポーズモデルを読み込み中…')
        const fileset = await FilesetResolver.forVisionTasks(WASM_URL)
        if (cancelled) return
        landmarker = await PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
          runningMode: 'VIDEO',
          numPoses: 1,
        })
        if (cancelled) return
        setStatus('')

        const loop = () => {
          if (cancelled || !landmarker) return
          const v = videoRef.current
          if (v && v.readyState >= 2 && v.currentTime !== lastVideoTime) {
            lastVideoTime = v.currentTime
            const res = landmarker.detectForVideo(v, performance.now())
            const lm = res.landmarks?.[0]
            if (lm && lm.length > 28) {
              // Mirror horizontally so the viewer sees themselves.
              const pts = lm.map((p) => ({
                x: 1 - p.x,
                y: p.y,
                v: p.visibility ?? 1,
              }))
              poseRef.current = { pts }
            }
          }
          raf = requestAnimationFrame(loop)
        }
        loop()
      } catch (e) {
        if (!cancelled) {
          setStatus('')
          setError(
            e instanceof Error ? e.message : 'カメラ/モデルの初期化に失敗しました',
          )
        }
      }
    }
    init()

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      landmarker?.close()
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  // Deformation loop. Head and feet bend by how far the body limb deviates from
  // its neutral hang. Arms bend by how far they deviate from a calibrated
  // baseline — the angle captured the first frame the pose was recognized — so
  // the starting pose reads as zero and returning to it un-bends the arm. Either
  // way the bend is eased, spread evenly along the branch, and the chain is
  // rebuilt from the fixed base using rest segment lengths, so the stroke only
  // curls, never stretches. No pose => zero bend => the glyph is at rest.
  useEffect(() => {
    let raf = 0
    const MAX_BEND = (Math.PI * 5) / 6 // clamp so limbs curl, never spiral
    const CALIB_DELAY = 500 // ms to wait after recognition before calibrating
    // When the pose first appears we stamp the time and hold the glyph at rest;
    // only after CALIB_DELAY do branches capture their baseline angle. Losing
    // the pose clears this and re-arms calibration for the next acquisition.
    let recognizedAt: number | null = null
    // Neck-driven whole-glyph skew: a calibrated head baseline plus an eased
    // current shear angle.
    const SKEW_GAIN = -0.5
    const SKEW_MAX = 0.3 // radians (~17°)
    let headBase: number | null = null
    let skewCur = 0
    const step = () => {
      const pose = poseRef.current
      const infl = influenceRef.current
      const gain = scaleRef.current
      const now = performance.now()
      if (pose) {
        if (recognizedAt === null) recognizedAt = now
      } else if (recognizedAt !== null) {
        recognizedAt = null
        headBase = null
        for (const inst of instancesRef.current)
          for (const br of inst.branches) br.inited = false
      }
      const calibrated =
        pose && recognizedAt !== null && now - recognizedAt >= CALIB_DELAY

      // Whole-text shear from the neck tilt (deviation from the head baseline).
      let skewTarget = 0
      if (calibrated && limbVisible('head', pose!.pts)) {
        const hd = limbDeviation('head', pose!.pts)
        if (headBase === null) headBase = hd
        skewTarget = normAngle(hd - headBase) * SKEW_GAIN
        if (skewTarget > SKEW_MAX) skewTarget = SKEW_MAX
        else if (skewTarget < -SKEW_MAX) skewTarget = -SKEW_MAX
      }
      skewCur += (skewTarget - skewCur) * 0.18
      skewRef.current = skewCur

      for (const inst of instancesRef.current) {
        const { rest, nodes: ns, branches } = inst
        // Reset to rest; branches then re-derive their own members.
        for (let i = 0; i < ns.length; i++) {
          ns[i].x = rest[i].x
          ns[i].y = rest[i].y
        }
        for (const br of branches) {
          // Each limb is calibrated CALIB_DELAY after recognition (not on the
          // first, still-settling frame): the angle captured then is the
          // baseline, so the held pose reads as zero bend and only movement away
          // from it curls the stroke. During the warmup the glyph stays at rest.
          let target = 0
          if (calibrated && limbVisible(br.role, pose!.pts)) {
            const raw = limbDeviation(br.role, pose!.pts)
            if (!br.inited) {
              br.baseAngle = raw
              br.inited = true
            }
            target =
              normAngle(raw - br.baseAngle) * infl * gain * ROLE_GAIN[br.role]
            if (target > MAX_BEND) target = MAX_BEND
            else if (target < -MAX_BEND) target = -MAX_BEND
          }
          br.bend += (target - br.bend) * 0.18

          // Rebuild base -> tip, rotating each rest segment by an angle that
          // accumulates along the chain (constant curvature).
          const segs = br.segRest
          const dPer = br.bend / segs.length
          let cum = 0
          let px = rest[br.base].x
          let py = rest[br.base].y
          for (let i = 0; i < segs.length; i++) {
            cum += dPer
            const ca = Math.cos(cum)
            const sa = Math.sin(cum)
            const v = segs[i]
            px += v.x * ca - v.y * sa
            py += v.x * sa + v.y * ca
            const node = br.chain[i + 1]
            ns[node].x = px
            ns[node].y = py
          }
        }
      }
      rerender()
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [])

  let caretOff = 0
  for (const ch of text) caretOff += isHankaku(ch) ? 0.5 : 1

  const contentW = Math.max(advance, caretOff * advance)
  const innerPad = 40
  const frameStroke = 4
  const frameRadius = 32
  const padding = 24 + innerPad + frameStroke
  const boxW = contentW
  const svgW = boxW + padding * 2
  const svgH = boxH + padding * 2

  const ROLE_COLOR: Record<Role, string> = {
    head: '#ff5d5d',
    leftHand: '#4a8cff',
    rightHand: '#27c2a0',
    leftFoot: '#ffab2e',
    rightFoot: '#b06cff',
  }

  return (
    <div
      style={{
        padding: 24,
        fontFamily: 'sans-serif',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
      }}
    >
      <div style={{ maxWidth: 720, textAlign: 'center', color: '#666', fontSize: 13 }}>
        <strong style={{ color: '#222' }}>文字になれる</strong> テキストフィールド —
        カメラの前で踊ると、文字の頭・両手・両足が人のポーズに追従します。
      </div>

      {error && (
        <div style={{ color: 'crimson', marginTop: 12 }}>エラー: {error}</div>
      )}
      {status && <div style={{ color: '#888', marginTop: 12 }}>{status}</div>}

      {fontMap && (
        <div
          style={{
            position: 'relative',
            display: 'inline-block',
            cursor: 'text',
            marginTop: 24,
          }}
          onClick={() => inputRef.current?.focus()}
        >
          <svg
            width={svgW}
            height={svgH}
            style={{ background: '#fff', borderRadius: 8, display: 'block' }}
          >
            <style>{`@keyframes lffp-caret { 0%,100%{opacity:1} 50%{opacity:0} }`}</style>
            <g transform={`translate(${padding}, ${padding})`}>
              {focused && (
                <rect
                  x={-innerPad - frameStroke / 2 - 6}
                  y={-innerPad - frameStroke / 2 - 6}
                  width={boxW + innerPad * 2 + frameStroke + 12}
                  height={boxH + innerPad * 2 + frameStroke + 12}
                  fill="none"
                  stroke="#4a8cff"
                  strokeOpacity={0.55}
                  strokeWidth={4}
                  rx={frameRadius + 6}
                />
              )}
              <rect
                x={-innerPad}
                y={-innerPad}
                width={boxW + innerPad * 2}
                height={boxH + innerPad * 2}
                fill="none"
                stroke="#222"
                strokeWidth={frameStroke}
                rx={frameRadius}
              />
              {text.length === 0 && (
                <text
                  x={0}
                  y={boxH * 0.5}
                  fill="#bbb"
                  fontSize={fontSize * 0.3}
                  fontFamily="system-ui, sans-serif"
                  dominantBaseline="middle"
                >
                  ここに入力…
                </text>
              )}
              {instancesRef.current.map((inst, i) => (
                // Neck-driven shear, pivoting on the baseline (y = boxH) so the
                // text leans from the bottom as the head tilts.
                <g
                  key={i}
                  transform={`translate(${(-Math.tan(skewRef.current) * boxH).toFixed(2)} 0) skewX(${((skewRef.current * 180) / Math.PI).toFixed(2)})`}
                >
                  {inst.strokes.map(([ai, bi], j) => {
                    const a = inst.nodes[ai]
                    const b = inst.nodes[bi]
                    return (
                      <line
                        key={j}
                        x1={a.x}
                        y1={a.y}
                        x2={b.x}
                        y2={b.y}
                        stroke="#000"
                        strokeWidth={6}
                        strokeLinecap="round"
                      />
                    )
                  })}
                  {showBranches &&
                    inst.branches.map((br) =>
                      // Each branch node as a dot: bigger/brighter toward the
                      // tip, so the bendable terminal (base -> tip) is visible.
                      br.chain.map((node, k) => {
                        const n = inst.nodes[node]
                        const w = k / Math.max(1, br.chain.length - 1)
                        return (
                          <circle
                            key={`${br.role}-${k}`}
                            cx={n.x}
                            cy={n.y}
                            r={2 + w * 5}
                            fill={ROLE_COLOR[br.role]}
                            opacity={0.25 + w * 0.6}
                          />
                        )
                      }),
                    )}
                </g>
              ))}
            </g>
          </svg>
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: 1,
              height: 1,
              opacity: 0,
              pointerEvents: 'none',
              border: 0,
              padding: 0,
            }}
          />
        </div>
      )}

      {/* Camera preview with the live skeleton, so the dancer can see themselves. */}
      <div
        style={{
          position: 'relative',
          marginTop: 20,
          width: 240,
          height: 180,
          borderRadius: 8,
          overflow: 'hidden',
          background: '#111',
          display: showCam ? 'block' : 'none',
        }}
      >
        <video
          ref={videoRef}
          playsInline
          muted
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            transform: 'scaleX(-1)',
          }}
        />
        <PoseOverlay poseRef={poseRef} colorOf={ROLE_COLOR} />
      </div>

      <details
        className="lffp-settings"
        style={{ width: '100%', maxWidth: 420, marginTop: 20 }}
      >
        <style>{`
          .lffp-settings label { font-size: 11px; color: #666; display: block; }
          .lffp-settings label > div { margin-bottom: 2px; }
          .lffp-settings input[type=range] {
            -webkit-appearance: none; appearance: none;
            accent-color: #000; height: 2px; background: #ddd; width: 100%;
          }
          .lffp-settings input[type=range]::-webkit-slider-thumb {
            -webkit-appearance: none; appearance: none;
            width: 12px; height: 12px; border-radius: 50%;
            background: #000; border: none; margin-top: -5px;
          }
        `}</style>
        <summary
          style={{
            cursor: 'pointer',
            padding: '8px 0',
            userSelect: 'none',
            fontSize: 12,
            color: '#888',
            textAlign: 'center',
            listStyle: 'none',
          }}
        >
          Settings
        </summary>
        <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
          <label>
            <div>追従の強さ（角度 → 曲がり）: {influence.toFixed(2)}</div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={influence}
              onChange={(e) => setInfluence(Number(e.target.value))}
            />
          </label>
          <label>
            <div>曲げの誇張: {scaleFactor.toFixed(2)}</div>
            <input
              type="range"
              min={0.4}
              max={2.5}
              step={0.05}
              value={scaleFactor}
              onChange={(e) => setScaleFactor(Number(e.target.value))}
            />
          </label>
          <label>
            <div>Font size: {fontSize}</div>
            <input
              type="range"
              min={60}
              max={260}
              value={fontSize}
              onChange={(e) => setFontSize(Number(e.target.value))}
            />
          </label>
          <label>
            <div>Kerning: {kerning}</div>
            <input
              type="range"
              min={-20}
              max={60}
              value={kerning}
              onChange={(e) => setKerning(Number(e.target.value))}
            />
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={showCam}
              onChange={(e) => setShowCam(e.target.checked)}
            />
            <span>カメラプレビューを表示</span>
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={showBranches}
              onChange={(e) => setShowBranches(e.target.checked)}
            />
            <span>枝の影響度を表示</span>
          </label>
        </div>
      </details>
    </div>
  )
}

// Small SVG overlay drawing the tracked skeleton joints on the camera preview.
function PoseOverlay({
  poseRef,
  colorOf,
}: {
  poseRef: React.RefObject<PoseFrame | null>
  colorOf: Record<Role, string>
}) {
  const [, setF] = useState(0)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      setF((n) => (n + 1) % 1_000_000)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  const pose = poseRef.current
  if (!pose) return null
  const W = 240
  const H = 180
  const pts = pose.pts
  const vis = (i: number) => (pts[i]?.v ?? 0) > 0.4
  const joints: { role: Role; idx: number }[] = [
    { role: 'head', idx: ROLE_LANDMARK.head },
    { role: 'leftHand', idx: ROLE_LANDMARK.leftHand },
    { role: 'rightHand', idx: ROLE_LANDMARK.rightHand },
    { role: 'leftFoot', idx: ROLE_LANDMARK.leftFoot },
    { role: 'rightFoot', idx: ROLE_LANDMARK.rightFoot },
  ]
  // Neck bone: nose to the shoulder midpoint.
  const sl = pts[POSE.leftShoulder]
  const sr = pts[POSE.rightShoulder]
  const nose = pts[POSE.nose]
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
      }}
    >
      {/* Bones */}
      {POSE_BONES.map(([a, b], i) => {
        if (!vis(a) || !vis(b)) return null
        return (
          <line
            key={i}
            x1={pts[a].x * W}
            y1={pts[a].y * H}
            x2={pts[b].x * W}
            y2={pts[b].y * H}
            stroke="#39ff88"
            strokeWidth={3}
            strokeLinecap="round"
            opacity={0.9}
          />
        )
      })}
      {sl && sr && nose && (
        <line
          x1={((sl.x + sr.x) / 2) * W}
          y1={((sl.y + sr.y) / 2) * H}
          x2={nose.x * W}
          y2={nose.y * H}
          stroke="#39ff88"
          strokeWidth={3}
          strokeLinecap="round"
          opacity={0.9}
        />
      )}
      {/* Body joints as small dots (skip the face mesh points 1–10). */}
      {pts.map((p, i) =>
        (i === 0 || i >= 11) && p.v > 0.4 ? (
          <circle key={`j${i}`} cx={p.x * W} cy={p.y * H} r={2} fill="#fff" />
        ) : null,
      )}
      {/* The five driving joints, in their role colors */}
      {joints.map(({ role, idx }) => {
        const p = pts[idx]
        if (!p || p.v <= 0.4) return null
        return (
          <circle
            key={role}
            cx={p.x * W}
            cy={p.y * H}
            r={5}
            fill={colorOf[role]}
            stroke="#000"
            strokeWidth={1}
          />
        )
      })}
    </svg>
  )
}

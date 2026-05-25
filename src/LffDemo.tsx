import { useEffect, useMemo, useRef, useState } from 'react'
import { parseLines, type Font } from './lib/lff/parser'
import { XYPad } from './XYPad'

const FONT_URL = `${import.meta.env.BASE_URL}kst32b.lff`

type PhysNode = {
  x: number
  y: number
  px: number
  py: number
}
type Edge = [number, number, number, number] // a, b, restLength, stiffness

type CharInstance = {
  letter: string
  nodes: PhysNode[]
  edges: Edge[]
  strokes: [number, number][]
}

function isHankaku(s: string) {
  return /^[\w ',&]+$/.test(s)
}

function buildCharInstance(
  letter: string,
  font: Font,
  fontSize: number,
  offsetX: number,
): CharInstance {
  const s = fontSize / 10
  const indexByKey = new Map<string, number>()
  const nodes: PhysNode[] = []
  const strokes: [number, number][] = []

  const addNode = (fx: number, fy: number): number => {
    const key = `${fx.toFixed(3)},${fy.toFixed(3)}`
    const existing = indexByKey.get(key)
    if (existing !== undefined) return existing
    const x = offsetX + fx * s
    const y = fy * -s + fontSize
    const idx = nodes.length
    nodes.push({ x, y, px: x, py: y })
    indexByKey.set(key, idx)
    return idx
  }

  type Split = { t: number; fx: number; fy: number }
  const raw = font.info
  const splits: Split[][] = raw.map(() => [])
  const eps = 1e-3
  const tolOnSeg = 1e-3
  const endpointSet = new Set<string>()
  const endpoints: { fx: number; fy: number }[] = []
  for (const ln of raw) {
    for (const [fx, fy] of [
      [ln.x1, ln.y1],
      [ln.x2, ln.y2],
    ] as const) {
      const key = `${fx.toFixed(3)},${fy.toFixed(3)}`
      if (endpointSet.has(key)) continue
      endpointSet.add(key)
      endpoints.push({ fx, fy })
    }
  }
  for (let i = 0; i < raw.length; i++) {
    const seg = raw[i]
    const dx = seg.x2 - seg.x1
    const dy = seg.y2 - seg.y1
    const len2 = dx * dx + dy * dy
    if (len2 < 1e-9) continue
    for (const p of endpoints) {
      const t = ((p.fx - seg.x1) * dx + (p.fy - seg.y1) * dy) / len2
      if (t <= eps || t >= 1 - eps) continue
      const cx = seg.x1 + dx * t
      const cy = seg.y1 + dy * t
      const distSq = (p.fx - cx) ** 2 + (p.fy - cy) ** 2
      if (distSq > tolOnSeg * tolOnSeg) continue
      splits[i].push({ t, fx: p.fx, fy: p.fy })
    }
  }
  for (let i = 0; i < raw.length; i++) {
    for (let j = i + 1; j < raw.length; j++) {
      const a = raw[i]
      const b = raw[j]
      const dx1 = a.x2 - a.x1
      const dy1 = a.y2 - a.y1
      const dx2 = b.x2 - b.x1
      const dy2 = b.y2 - b.y1
      const denom = dx1 * dy2 - dy1 * dx2
      if (Math.abs(denom) < 1e-9) continue
      const ox = b.x1 - a.x1
      const oy = b.y1 - a.y1
      const t1 = (ox * dy2 - oy * dx2) / denom
      const t2 = (ox * dy1 - oy * dx1) / denom
      if (t1 <= eps || t1 >= 1 - eps) continue
      if (t2 <= eps || t2 >= 1 - eps) continue
      const fx = a.x1 + dx1 * t1
      const fy = a.y1 + dy1 * t1
      splits[i].push({ t: t1, fx, fy })
      splits[j].push({ t: t2, fx, fy })
    }
  }

  for (let i = 0; i < raw.length; i++) {
    const seg = raw[i]
    const pts: Split[] = [
      { t: 0, fx: seg.x1, fy: seg.y1 },
      ...splits[i],
      { t: 1, fx: seg.x2, fy: seg.y2 },
    ]
    pts.sort((p, q) => p.t - q.t)
    for (let k = 0; k < pts.length - 1; k++) {
      const a = addNode(pts[k].fx, pts[k].fy)
      const b = addNode(pts[k + 1].fx, pts[k + 1].fy)
      if (a !== b) strokes.push([a, b])
    }
  }

  const edges: Edge[] = strokes.map(([a, b]) => {
    const na = nodes[a]
    const nb = nodes[b]
    return [a, b, Math.hypot(nb.x - na.x, nb.y - na.y), 1]
  })

  // Bending constraints: for every pair of stroke edges sharing a node,
  // add a virtual spring between the other endpoints. Preserves local angles.
  const incident: number[][] = nodes.map(() => [])
  strokes.forEach(([a, b], i) => {
    incident[a].push(i)
    incident[b].push(i)
  })
  const seen = new Set<string>()
  for (let n = 0; n < nodes.length; n++) {
    const inc = incident[n]
    for (let i = 0; i < inc.length; i++) {
      for (let j = i + 1; j < inc.length; j++) {
        const [a1, b1] = strokes[inc[i]]
        const [a2, b2] = strokes[inc[j]]
        const other1 = a1 === n ? b1 : a1
        const other2 = a2 === n ? b2 : a2
        if (other1 === other2) continue
        const lo = Math.min(other1, other2)
        const hi = Math.max(other1, other2)
        const key = `${lo},${hi}`
        if (seen.has(key)) continue
        seen.add(key)
        const na = nodes[other1]
        const nb = nodes[other2]
        const rest = Math.hypot(nb.x - na.x, nb.y - na.y)
        edges.push([other1, other2, rest, 0.35])
      }
    }
  }

  return { letter, nodes, edges, strokes }
}

export function LffDemo() {
  const [text, setText] = useState('')
  const [fontSize, setFontSize] = useState(110)
  const [kerning, setKerning] = useState(30)
  const [gravity, setGravity] = useState(0.01)
  const [gravityX, setGravityX] = useState(-0.005)
  const [collision, setCollision] = useState(10)
  const [boxWidthPx, setBoxWidthPx] = useState(1200)
  const [boxHeightRatio, setBoxHeightRatio] = useState(1.0)
  const [repulsion, setRepulsion] = useState(0.05)
  const [fontMap, setFontMap] = useState<Record<string, Font> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const instancesRef = useRef<CharInstance[]>([])
  const gravityRef = useRef(gravity)
  const gravityXRef = useRef(gravityX)
  const collisionRef = useRef(collision)
  const repulsionRef = useRef(repulsion)
  const fontSizeRef = useRef(fontSize)
  const boxRef = useRef({ left: 0, right: 0, top: 0, bottom: 0 })
  const buildKeyRef = useRef('')
  const [, setFrame] = useState(0)
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    gravityRef.current = gravity
  }, [gravity])

  useEffect(() => {
    gravityXRef.current = gravityX
  }, [gravityX])

  useEffect(() => {
    collisionRef.current = collision
  }, [collision])

  useEffect(() => {
    repulsionRef.current = repulsion
  }, [repulsion])

  useEffect(() => {
    fontSizeRef.current = fontSize
  }, [fontSize])

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

  useEffect(() => {
    if (!fontMap) return
    const advance = fontSize - kerning
    const maxOffset = Math.max(0, boxWidthPx - advance)
    const buildKey = `${fontSize}|${kerning}|${boxWidthPx}`
    const fullRebuild = buildKey !== buildKeyRef.current
    buildKeyRef.current = buildKey
    const prev = instancesRef.current

    const target: { letter: string; offsetX: number; font: Font }[] = []
    let off = 0
    for (const ch of text) {
      const font = fontMap[ch]
      if (font) {
        const offsetX = Math.min(off * advance, maxOffset)
        target.push({ letter: ch, offsetX, font })
      }
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
    setFrame((f) => f + 1)
  }, [text, fontSize, kerning, boxWidthPx, fontMap])

  useEffect(() => {
    let raf = 0
    const damping = 0.99
    const iters = 12
    const friction = 0.85
    const step = () => {
      const g = gravityRef.current
      const gx = gravityXRef.current
      const box = boxRef.current
      const col = collisionRef.current
      const col2 = col * col
      const rep = repulsionRef.current
      const minDist = fontSizeRef.current * 0.25
      const minDist2 = minDist * minDist

      const allNodes: PhysNode[] = []
      const allSegs: [number, number][] = []
      let nodeBase = 0
      for (const inst of instancesRef.current) {
        for (const n of inst.nodes) allNodes.push(n)
        for (const [a, b] of inst.strokes) allSegs.push([a + nodeBase, b + nodeBase])
        nodeBase += inst.nodes.length
      }

      for (const inst of instancesRef.current) {
        if (rep > 0) {
          const ns = inst.nodes
          for (let i = 0; i < ns.length; i++) {
            const a = ns[i]
            for (let j = i + 1; j < ns.length; j++) {
              const b = ns[j]
              const dx = b.x - a.x
              const dy = b.y - a.y
              const d2 = dx * dx + dy * dy
              if (d2 >= minDist2 || d2 < 0.0001) continue
              const d = Math.sqrt(d2)
              const push = ((minDist - d) / d) * 0.5 * rep
              a.x -= dx * push
              a.y -= dy * push
              b.x += dx * push
              b.y += dy * push
            }
          }
        }
        for (const n of inst.nodes) {
          const vx = (n.x - n.px) * damping
          const vy = (n.y - n.py) * damping
          n.px = n.x
          n.py = n.y
          n.x += vx + gx
          n.y += vy + g
        }
        for (let it = 0; it < iters; it++) {
          for (const [ai, bi, rest, stiff] of inst.edges) {
            const a = inst.nodes[ai]
            const b = inst.nodes[bi]
            const dx = b.x - a.x
            const dy = b.y - a.y
            const dist = Math.hypot(dx, dy) || 0.0001
            const diff = ((rest - dist) / dist) * stiff
            a.x -= dx * diff * 0.5
            a.y -= dy * diff * 0.5
            b.x += dx * diff * 0.5
            b.y += dy * diff * 0.5
          }
          for (const n of inst.nodes) {
            if (n.y > box.bottom) {
              n.y = box.bottom
              const vx = n.x - n.px
              n.px = n.x - vx * friction
            }
            if (n.y < box.top) n.y = box.top
            if (n.x < box.left) n.x = box.left
            if (n.x > box.right) n.x = box.right
          }
        }
      }

      if (col > 0) {
        for (let it = 0; it < 3; it++) {
          for (let s = 0; s < allSegs.length; s++) {
            const ai = allSegs[s][0]
            const bi = allSegs[s][1]
            const a = allNodes[ai]
            const b = allNodes[bi]
            const ex = b.x - a.x
            const ey = b.y - a.y
            const len2 = ex * ex + ey * ey
            if (len2 < 0.001) continue
            for (let k = 0; k < allNodes.length; k++) {
              if (k === ai || k === bi) continue
              const n = allNodes[k]
              const t = ((n.x - a.x) * ex + (n.y - a.y) * ey) / len2
              if (t < 0 || t > 1) continue
              const cx = a.x + ex * t
              const cy = a.y + ey * t
              const dx = n.x - cx
              const dy = n.y - cy
              const d2 = dx * dx + dy * dy
              if (d2 >= col2 || d2 < 0.0001) continue
              const d = Math.sqrt(d2)
              const overlap = col - d
              const nx = dx / d
              const ny = dy / d
              const wa = 1 - t
              const wb = t
              const denom = wa * wa + wb * wb + 1
              const move = overlap / denom
              n.x += nx * move
              n.y += ny * move
              a.x -= nx * move * wa
              a.y -= ny * move * wa
              b.x -= nx * move * wb
              b.y -= ny * move * wb
            }
          }
          for (const n of allNodes) {
            if (n.y > box.bottom) {
              n.y = box.bottom
              const vx = n.x - n.px
              n.px = n.x - vx * friction
            }
            if (n.y < box.top) n.y = box.top
            if (n.x < box.left) n.x = box.left
            if (n.x > box.right) n.x = box.right
          }
        }
      }

      setFrame((f) => (f + 1) % 1_000_000)
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [])

  const innerPad = 16
  const frameStroke = 4
  const frameRadius = 32
  const padding = 24 + innerPad + frameStroke
  const advance = fontSize - kerning
  const boxW = boxWidthPx
  const boxH = fontSize * boxHeightRatio
  const caretX = useMemo(() => {
    let off = 0
    for (const ch of text) off += isHankaku(ch) ? 0.5 : 1
    return Math.min(off * advance, Math.max(0, boxW - advance))
  }, [text, advance, boxW])
  const svgW = boxW + padding * 2
  const svgH = boxH + padding * 2
  boxRef.current = { left: 0, right: boxW, top: 0, bottom: boxH }

  return (
    <div style={{ padding: 24, fontFamily: 'sans-serif', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <details style={{ alignSelf: 'center', width: '100%', maxWidth: 480, marginTop: 24, order: 3 }}>
        <summary style={{ cursor: 'pointer', padding: '8px 0', userSelect: 'none' }}>Settings</summary>
        <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
        <label>
          <div>Font size: {fontSize}</div>
          <input
            type="range"
            min={24}
            max={160}
            value={fontSize}
            onChange={(e) => setFontSize(Number(e.target.value))}
            style={{ width: '100%' }}
          />
        </label>
        <label>
          <div>Kerning: {kerning}</div>
          <input
            type="range"
            min={-20}
            max={40}
            value={kerning}
            onChange={(e) => setKerning(Number(e.target.value))}
            style={{ width: '100%' }}
          />
        </label>
        <label>
          <div>Box width: {boxWidthPx}px</div>
          <input
            type="range"
            min={200}
            max={3000}
            step={20}
            value={boxWidthPx}
            onChange={(e) => setBoxWidthPx(Number(e.target.value))}
            style={{ width: '100%' }}
          />
        </label>
        <label>
          <div>Box height: {boxHeightRatio.toFixed(2)} × fontSize</div>
          <input
            type="range"
            min={0.6}
            max={3}
            step={0.05}
            value={boxHeightRatio}
            onChange={(e) => setBoxHeightRatio(Number(e.target.value))}
            style={{ width: '100%' }}
          />
        </label>
        <label>
          <div>Repulsion: {repulsion.toFixed(2)}</div>
          <input
            type="range"
            min={0}
            max={3}
            step={0.05}
            value={repulsion}
            onChange={(e) => setRepulsion(Number(e.target.value))}
            style={{ width: '100%' }}
          />
        </label>
        <label>
          <div>Collision radius: {collision.toFixed(1)}</div>
          <input
            type="range"
            min={0}
            max={20}
            step={0.5}
            value={collision}
            onChange={(e) => setCollision(Number(e.target.value))}
            style={{ width: '100%' }}
          />
        </label>
        </div>
      </details>

      <div style={{ order: 2, marginTop: 16, textAlign: 'center' }}>
        <XYPad
          x={gravityX}
          y={gravity}
          xMin={-0.2}
          xMax={0.2}
          yMin={-0.2}
          yMax={0.2}
          onChange={(nx, ny) => {
            setGravityX(nx)
            setGravity(ny)
          }}
          labelX="Gx"
          labelY="Gy"
        />
      </div>

      {error && <div style={{ color: 'crimson' }}>Failed to load font: {error}</div>}
      {!fontMap && !error && <div>Loading font…</div>}

      {fontMap && (
        <div
          style={{ position: 'relative', display: 'inline-block', cursor: 'text', marginTop: 48 }}
          onClick={() => inputRef.current?.focus()}
        >
          <svg width={svgW} height={svgH} style={{ background: '#fff', borderRadius: 8, display: 'block' }}>
          <style>{`@keyframes lff-caret-blink { 0%,100% { opacity:1 } 50% { opacity:0 } }`}</style>
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
                fontSize={fontSize * 0.35}
                fontFamily="system-ui, sans-serif"
                dominantBaseline="middle"
              >
                Type here…
              </text>
            )}
            <line
              x1={caretX}
              y1={boxH * 0.12}
              x2={caretX}
              y2={boxH * 0.88}
              stroke="#222"
              strokeWidth={4}
              strokeLinecap="round"
              style={{ animation: 'lff-caret-blink 1.1s ease-in-out infinite' }}
            />
            {instancesRef.current.map((inst, i) => (
              <g key={i}>
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
    </div>
  )
}

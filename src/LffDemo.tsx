import { useEffect, useMemo, useRef, useState } from 'react'
import { parseLines, type Font } from './lib/lff/parser'

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
    const key = `${fx.toFixed(4)},${fy.toFixed(4)}`
    const existing = indexByKey.get(key)
    if (existing !== undefined) return existing
    const x = offsetX + fx * s
    const y = fy * -s + fontSize
    const idx = nodes.length
    nodes.push({ x, y, px: x, py: y })
    indexByKey.set(key, idx)
    return idx
  }

  for (const ln of font.info) {
    const a = addNode(ln.x1, ln.y1)
    const b = addNode(ln.x2, ln.y2)
    strokes.push([a, b])
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
  const [text, setText] = useState('LFF')
  const [fontSize, setFontSize] = useState(160)
  const [kerning, setKerning] = useState(40)
  const [gravity, setGravity] = useState(0.01)
  const [repulsion, setRepulsion] = useState(0.05)
  const [fontMap, setFontMap] = useState<Record<string, Font> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const instancesRef = useRef<CharInstance[]>([])
  const gravityRef = useRef(gravity)
  const repulsionRef = useRef(repulsion)
  const fontSizeRef = useRef(fontSize)
  const floorYRef = useRef(0)
  const buildKeyRef = useRef('')
  const [, setFrame] = useState(0)

  useEffect(() => {
    gravityRef.current = gravity
  }, [gravity])

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
    setFrame((f) => f + 1)
  }, [text, fontSize, kerning, fontMap])

  useEffect(() => {
    let raf = 0
    const damping = 0.99
    const iters = 12
    const friction = 0.85
    const step = () => {
      const g = gravityRef.current
      const floorY = floorYRef.current
      const rep = repulsionRef.current
      const minDist = fontSizeRef.current * 0.25
      const minDist2 = minDist * minDist
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
          n.x += vx
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
            if (n.y > floorY) {
              n.y = floorY
              const vx = n.x - n.px
              n.px = n.x - vx * friction
            }
          }
        }
      }
      setFrame((f) => (f + 1) % 1_000_000)
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [])

  const padding = 24
  const advance = fontSize - kerning
  const totalWidth = useMemo(() => {
    let off = 0
    let last = 0
    for (const ch of text) {
      last = off
      off += isHankaku(ch) ? 0.5 : 1
    }
    return text.length ? (last + 1) * advance : 0
  }, [text, advance])
  const svgW = Math.max(totalWidth + padding * 2, 240)
  const svgH = fontSize * 2 + padding * 2
  const floorY = svgH - padding * 2 - 4
  floorYRef.current = floorY

  return (
    <div style={{ padding: 24, fontFamily: 'sans-serif' }}>
      <h1 style={{ marginTop: 0 }}>LFF Spring Demo</h1>
      <p style={{ color: '#666' }}>各ノードにバネと重力 / 折れ曲がり防止のbendingバネ / 床あり</p>

      <div style={{ display: 'grid', gap: 12, maxWidth: 480, marginBottom: 24 }}>
        <label>
          <div>Text</div>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            style={{ width: '100%', padding: 8, fontSize: 16 }}
          />
        </label>
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
          <div>Gravity: {gravity.toFixed(2)}</div>
          <input
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={gravity}
            onChange={(e) => setGravity(Number(e.target.value))}
            style={{ width: '100%' }}
          />
        </label>
      </div>

      {error && <div style={{ color: 'crimson' }}>Failed to load font: {error}</div>}
      {!fontMap && !error && <div>Loading font…</div>}

      {fontMap && (
        <svg width={svgW} height={svgH} style={{ background: '#fff', borderRadius: 8 }}>
          <g transform={`translate(${padding}, ${padding})`}>
            <line
              x1={0}
              y1={floorY}
              x2={svgW - padding * 2}
              y2={floorY}
              stroke="#555"
              strokeWidth={1}
              strokeDasharray="4 4"
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
                      strokeWidth={1.5}
                      strokeLinecap="round"
                    />
                  )
                })}
              </g>
            ))}
          </g>
        </svg>
      )}
    </div>
  )
}

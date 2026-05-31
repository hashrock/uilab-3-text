import { useEffect, useRef, useState } from 'react'
import { parseLines, type Font } from './lib/lff/parser'

const FONT_URL = `${import.meta.env.BASE_URL}kst32b.lff`

type Node = { x: number; y: number }

type CharInstance = {
  letter: string
  nodes: Node[]
  strokes: [number, number][]
  rests: number[] // rest length per stroke, index-aligned with strokes
}

function isHankaku(s: string) {
  return /^[\w ',&]+$/.test(s)
}

// Convert a glyph's raw font lines into positioned nodes + strokes (no physics).
//
// Shared endpoints are deduplicated so a corner is a single node, and each line
// is subdivided into a chain of short segments. Connectivity (the topology) is
// fixed once built — deformation only moves node positions — so a straight line
// can bend into a smooth polyline under the brush while staying topologically
// the same glyph.
function buildCharInstance(
  letter: string,
  font: Font,
  fontSize: number,
  offsetX: number,
): CharInstance {
  const s = fontSize / 10
  const subLen = Math.max(6, fontSize * 0.1) // target sub-segment length in px
  const indexByKey = new Map<string, number>()
  const nodes: Node[] = []
  const strokes: [number, number][] = []

  // Endpoints dedup across the whole glyph so corners are shared nodes.
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
      // Interior points are unique to this line (not deduped), so each line is
      // its own bendable chain between the shared corner nodes.
      nodes.push({ x: ax + (bx - ax) * t, y: ay + (by - ay) * t })
      strokes.push([prev, idx])
      prev = idx
    }
    strokes.push([prev, b])
  }

  const rests = strokes.map(([a, b]) =>
    Math.hypot(nodes[b].x - nodes[a].x, nodes[b].y - nodes[a].y),
  )

  return { letter, nodes, strokes, rests }
}

export function LffStatic() {
  const [text, setText] = useState('')
  const [fontSize, setFontSize] = useState(110)
  const [kerning, setKerning] = useState(0)
  const [boxWidthPx, setBoxWidthPx] = useState(1200)
  const [boxHeightRatio, setBoxHeightRatio] = useState(1.0)
  const [brushRadius, setBrushRadius] = useState(90)
  const [repulsion, setRepulsion] = useState(0.1)
  const [fontMap, setFontMap] = useState<Record<string, Font> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  const instancesRef = useRef<CharInstance[]>([])
  const buildKeyRef = useRef('')
  // While dragging: the last pointer position (local coords). The brush nudges
  // nodes incrementally each move so it composes with the repulsion loop instead
  // of resetting nodes from a stale snapshot.
  const dragRef = useRef<{ lx: number; ly: number } | null>(null)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  const [, setFrame] = useState(0)
  const rerender = () => setFrame((f) => (f + 1) % 1_000_000)
  const repulsionRef = useRef(repulsion)
  const fontSizeRef = useRef(fontSize)

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

  const advance = fontSize - kerning
  const boxW = boxWidthPx
  const boxH = fontSize * boxHeightRatio

  // Rebuild glyph instances. Layout params force a full rebuild; otherwise
  // unchanged leading characters keep their (possibly edited) nodes so typing
  // doesn't discard manual edits.
  useEffect(() => {
    if (!fontMap) return
    const maxOffset = Math.max(0, boxW - advance)
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
    rerender()
  }, [text, fontSize, kerning, boxWidthPx, boxW, advance, fontMap])

  // Relaxation loop: repel nearby vertices, then restore stroke rest lengths so
  // the topology and segment lengths survive. Pure positional solve (no
  // velocity), so it settles to equilibrium rather than oscillating forever.
  useEffect(() => {
    let raf = 0
    const iters = 8
    const step = () => {
      const rep = repulsionRef.current
      const minDist = fontSizeRef.current * 0.2
      const minDist2 = minDist * minDist
      for (const inst of instancesRef.current) {
        const ns = inst.nodes
        if (rep > 0) {
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
        for (let it = 0; it < iters; it++) {
          const { strokes, rests } = inst
          for (let s = 0; s < strokes.length; s++) {
            const a = ns[strokes[s][0]]
            const b = ns[strokes[s][1]]
            const dx = b.x - a.x
            const dy = b.y - a.y
            const dist = Math.hypot(dx, dy) || 0.0001
            const diff = (rests[s] - dist) / dist
            a.x -= dx * diff * 0.5
            a.y -= dy * diff * 0.5
            b.x += dx * diff * 0.5
            b.y += dy * diff * 0.5
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
  const caretX = Math.min(caretOff * advance, Math.max(0, boxW - advance))

  const innerPad = 16
  const frameStroke = 4
  const frameRadius = 32
  const padding = 24 + innerPad + frameStroke
  const svgW = boxW + padding * 2
  const svgH = boxH + padding * 2

  // Translate a pointer event into the inner (post-translate) coordinate space,
  // accounting for any CSS scaling of the SVG element.
  const toLocal = (e: { clientX: number; clientY: number }) => {
    const rect = svgRef.current!.getBoundingClientRect()
    const sx = rect.width / svgW
    const sy = rect.height / svgH
    return {
      x: (e.clientX - rect.left) / sx - padding,
      y: (e.clientY - rect.top) / sy - padding,
    }
  }

  // Proportional-edit falloff: full strength at the cursor, smoothly fading to
  // zero at the brush radius.
  const falloff = (d: number, r: number) => {
    if (d >= r) return 0
    const t = 1 - (d * d) / (r * r)
    return t * t
  }

  const startDrag = (e: React.PointerEvent) => {
    const { x, y } = toLocal(e)
    dragRef.current = { lx: x, ly: y }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const { x, y } = toLocal(e)
    setCursor({ x, y })
    const drag = dragRef.current
    if (!drag) return
    const dx = x - drag.lx
    const dy = y - drag.ly
    drag.lx = x
    drag.ly = y
    for (const inst of instancesRef.current) {
      for (const n of inst.nodes) {
        const d = Math.hypot(n.x - x, n.y - y)
        const w = falloff(d, brushRadius)
        if (w === 0) continue
        n.x += dx * w
        n.y += dy * w
      }
    }
    rerender()
  }

  const endDrag = (e: React.PointerEvent) => {
    if (!dragRef.current) return
    dragRef.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  return (
    <div style={{ padding: 24, fontFamily: 'sans-serif', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <details className="lff-settings" style={{ alignSelf: 'center', width: '100%', maxWidth: 480, marginTop: 24, order: 3 }}>
        <style>{`
          .lff-settings label { font-size: 11px; color: #666; display: block; }
          .lff-settings label > div { margin-bottom: 2px; }
          .lff-settings input[type=range] {
            -webkit-appearance: none;
            appearance: none;
            accent-color: #000;
            height: 2px;
            background: #ddd;
          }
          .lff-settings input[type=range]::-webkit-slider-runnable-track {
            height: 2px; background: #ddd; border-radius: 1px;
          }
          .lff-settings input[type=range]::-webkit-slider-thumb {
            -webkit-appearance: none; appearance: none;
            width: 12px; height: 12px; border-radius: 50%;
            background: #000; border: none; margin-top: -5px;
          }
          .lff-settings input[type=range]::-moz-range-track {
            height: 2px; background: #ddd; border-radius: 1px;
          }
          .lff-settings input[type=range]::-moz-range-thumb {
            width: 12px; height: 12px; border-radius: 50%;
            background: #000; border: none;
          }
        `}</style>
        <summary style={{ cursor: 'pointer', padding: '8px 0', userSelect: 'none', fontSize: 12, color: '#888', textAlign: 'center', listStyle: 'none' }}>Settings</summary>
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
            <div>Brush radius: {brushRadius}px</div>
            <input
              type="range"
              min={10}
              max={400}
              step={5}
              value={brushRadius}
              onChange={(e) => setBrushRadius(Number(e.target.value))}
              style={{ width: '100%' }}
            />
          </label>
          <label>
            <div>Repulsion: {repulsion.toFixed(2)}</div>
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={repulsion}
              onChange={(e) => setRepulsion(Number(e.target.value))}
              style={{ width: '100%' }}
            />
          </label>
        </div>
      </details>

      {error && <div style={{ color: 'crimson' }}>Failed to load font: {error}</div>}
      {!fontMap && !error && <div>Loading font…</div>}

      {fontMap && (
        <div
          style={{ position: 'relative', display: 'inline-block', cursor: 'text', marginTop: 40 }}
          onClick={() => inputRef.current?.focus()}
        >
          <svg
            ref={svgRef}
            width={svgW}
            height={svgH}
            style={{ background: '#fff', borderRadius: 8, display: 'block', touchAction: 'none', cursor: 'crosshair' }}
            onPointerDown={startDrag}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onPointerLeave={() => setCursor(null)}
          >
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
              {/* Brush influence ring following the cursor. */}
              {cursor && (
                <circle
                  cx={cursor.x}
                  cy={cursor.y}
                  r={brushRadius}
                  fill="none"
                  stroke="#4a8cff"
                  strokeOpacity={0.5}
                  strokeWidth={1.5}
                  style={{ pointerEvents: 'none' }}
                />
              )}
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

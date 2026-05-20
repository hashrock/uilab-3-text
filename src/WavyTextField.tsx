import { useEffect, useId, useRef, useState } from 'react'

type Props = {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  width?: number
  height?: number
}

type RopeNode = { x: number; y: number; px: number; py: number }

export function WavyTextField({
  value,
  onChange,
  placeholder,
  width = 480,
  height = 180,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const measureCanvas = useRef<HTMLCanvasElement | null>(null)
  const nodesRef = useRef<RopeNode[]>([])
  const restLensRef = useRef<number[]>([])
  const valueRef = useRef(value)
  const [focused, setFocused] = useState(false)
  const [cursorIndex, setCursorIndex] = useState(0)
  const [, setFrame] = useState(0)
  const [debug, setDebug] = useState(false)
  const reactId = useId()
  const pathId = `curve-center-${reactId.replace(/:/g, '')}`

  const padX = 44
  const padY = 32
  const halfH = 22
  const curveAmp = 16
  const ringGap = 6
  const fontSize = 18
  const fontFamily = 'system-ui, sans-serif'
  const startOffset = 16
  const segmentCount = 50

  const gravity = 0.35
  const damping = 0.985
  const loadWeight = 2.2
  const constraintIters = 30

  const measureText = (text: string) => {
    if (!measureCanvas.current) {
      measureCanvas.current = document.createElement('canvas')
    }
    const ctx = measureCanvas.current.getContext('2d')
    if (!ctx) return 0
    ctx.font = `${fontSize}px ${fontFamily}`
    return ctx.measureText(text).width
  }

  useEffect(() => {
    valueRef.current = value
  }, [value])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === '.' && document.activeElement !== inputRef.current) {
        setDebug((d) => !d)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  useEffect(() => {
    const nodes: RopeNode[] = []
    for (let i = 0; i <= segmentCount; i++) {
      const t = i / segmentCount
      const x = padX + (width - padX * 2) * t
      const y = padY + curveAmp * 4 * t * (1 - t)
      nodes.push({ x, y, px: x, py: y })
    }
    const restLens: number[] = []
    for (let i = 0; i < segmentCount; i++) {
      const a = nodes[i]
      const b = nodes[i + 1]
      restLens.push(Math.hypot(b.x - a.x, b.y - a.y))
    }
    nodesRef.current = nodes
    restLensRef.current = restLens
    setFrame((f) => f + 1)
  }, [width, height])

  useEffect(() => {
    let raf = 0
    const step = () => {
      const nodes = nodesRef.current
      const restLens = restLensRef.current
      if (nodes.length === segmentCount + 1) {
        const v = valueRef.current
        const textLen = v ? measureText(v) : 0
        const leading = v.match(/^\s+/)?.[0] ?? ''
        const leadingLen = leading ? measureText(leading) : 0
        const textStart = startOffset + leadingLen
        const textEnd = startOffset + textLen

        const segLoads: number[] = []
        let cum = 0
        for (let i = 0; i < segmentCount; i++) {
          const a = nodes[i]
          const b = nodes[i + 1]
          const d = Math.hypot(b.x - a.x, b.y - a.y)
          const overlap = Math.max(0, Math.min(cum + d, textEnd) - Math.max(cum, textStart))
          segLoads.push(d > 0 ? overlap / d : 0)
          cum += d
        }

        for (let i = 1; i < segmentCount; i++) {
          const n = nodes[i]
          const w = 1 + ((segLoads[i - 1] + segLoads[i]) / 2) * loadWeight
          const vx = (n.x - n.px) * damping
          const vy = (n.y - n.py) * damping
          n.px = n.x
          n.py = n.y
          n.x += vx
          n.y += vy + gravity * w
        }

        for (let it = 0; it < constraintIters; it++) {
          for (let i = 0; i < segmentCount; i++) {
            const a = nodes[i]
            const b = nodes[i + 1]
            const dx = b.x - a.x
            const dy = b.y - a.y
            const dist = Math.hypot(dx, dy) || 0.0001
            const diff = (restLens[i] - dist) / dist
            const aPinned = i === 0
            const bPinned = i + 1 === segmentCount
            if (aPinned && bPinned) continue
            if (aPinned) {
              b.x += dx * diff
              b.y += dy * diff
            } else if (bPinned) {
              a.x -= dx * diff
              a.y -= dy * diff
            } else {
              a.x -= dx * diff * 0.5
              a.y -= dy * diff * 0.5
              b.x += dx * diff * 0.5
              b.y += dy * diff * 0.5
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

  const updateCursor = () => {
    if (inputRef.current) {
      setCursorIndex(inputRef.current.selectionStart ?? 0)
    }
  }

  const displayText = value || placeholder || ''
  const isPlaceholder = !value && !!placeholder
  const caretH = 13

  const nodes = nodesRef.current
  const ready = nodes.length === segmentCount + 1

  const tangents: { tx: number; ty: number }[] = []
  if (ready) {
    for (let i = 0; i <= segmentCount; i++) {
      let dx: number
      let dy: number
      if (i === 0) {
        dx = nodes[1].x - nodes[0].x
        dy = nodes[1].y - nodes[0].y
      } else if (i === segmentCount) {
        dx = nodes[i].x - nodes[i - 1].x
        dy = nodes[i].y - nodes[i - 1].y
      } else {
        dx = nodes[i + 1].x - nodes[i - 1].x
        dy = nodes[i + 1].y - nodes[i - 1].y
      }
      const len = Math.hypot(dx, dy) || 1
      tangents.push({ tx: dx / len, ty: dy / len })
    }
  }

  const centerPathD = ready
    ? nodes
        .map((n, i) => `${i === 0 ? 'M' : 'L'}${n.x.toFixed(2)} ${n.y.toFixed(2)}`)
        .join(' ')
    : ''

  const buildRibbonD = (h: number) => {
    if (!ready) return ''
    const top: { x: number; y: number }[] = []
    const bot: { x: number; y: number }[] = []
    for (let i = 0; i <= segmentCount; i++) {
      const n = nodes[i]
      const { tx, ty } = tangents[i]
      const nx = -ty
      const ny = tx
      top.push({ x: n.x - nx * h, y: n.y - ny * h })
      bot.push({ x: n.x + nx * h, y: n.y + ny * h })
    }
    const parts: string[] = []
    top.forEach((p, i) => {
      parts.push(`${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
    })
    const right = bot[segmentCount]
    parts.push(`A${h} ${h} 0 0 1 ${right.x.toFixed(2)} ${right.y.toFixed(2)}`)
    for (let i = segmentCount - 1; i >= 0; i--) {
      parts.push(`L${bot[i].x.toFixed(2)} ${bot[i].y.toFixed(2)}`)
    }
    const left = top[0]
    parts.push(`A${h} ${h} 0 0 1 ${left.x.toFixed(2)} ${left.y.toFixed(2)}`)
    parts.push('Z')
    return parts.join(' ')
  }

  const ribbonD = buildRibbonD(halfH)
  const ringD = buildRibbonD(halfH + ringGap)

  type Segment = { x: number; y: number; angle: number; load: number }
  const segments: Segment[] = []
  let caret: { x: number; y: number; angle: number } | null = null
  if (ready) {
    const textLen = value ? measureText(value) : 0
    const leading = value.match(/^\s+/)?.[0] ?? ''
    const leadingLen = leading ? measureText(leading) : 0
    const textStart = startOffset + leadingLen
    const textEnd = startOffset + textLen
    let cum = 0
    for (let i = 0; i < segmentCount; i++) {
      const a = nodes[i]
      const b = nodes[i + 1]
      const d = Math.hypot(b.x - a.x, b.y - a.y)
      const mx = (a.x + b.x) / 2
      const my = (a.y + b.y) / 2
      const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
      const overlap = Math.max(0, Math.min(cum + d, textEnd) - Math.max(cum, textStart))
      const load = d > 0 ? overlap / d : 0
      segments.push({ x: mx, y: my, angle, load })
      cum += d
    }
    if (focused) {
      const before = value.slice(0, cursorIndex)
      const target = startOffset + measureText(before)
      let walked = 0
      for (let i = 0; i < segmentCount; i++) {
        const a = nodes[i]
        const b = nodes[i + 1]
        const d = Math.hypot(b.x - a.x, b.y - a.y)
        if (walked + d >= target || i === segmentCount - 1) {
          const t = d > 0 ? Math.max(0, Math.min(1, (target - walked) / d)) : 0
          const x = a.x + (b.x - a.x) * t
          const y = a.y + (b.y - a.y) * t
          const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
          caret = { x, y, angle }
          break
        }
        walked += d
      }
    }
  }

  return (
    <div
      style={{ position: 'relative', display: 'inline-block', cursor: 'text' }}
      onClick={() => inputRef.current?.focus()}
    >
      <style>{`
        @keyframes wavy-caret-blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
      `}</style>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ overflow: 'visible' }}
      >
        <defs>
          <path id={pathId} d={centerPathD} fill="none" />
        </defs>
        {focused && (
          <path
            d={ringD}
            fill="none"
            stroke="#aa3bff"
            strokeOpacity={0.45}
            strokeWidth={4}
            strokeLinejoin="round"
          />
        )}
        <path
          d={ribbonD}
          fill="#fff"
          stroke="#08060d"
          strokeWidth={2}
          strokeLinejoin="round"
        />
        <text
          fontSize={fontSize}
          fontFamily={fontFamily}
          fill={isPlaceholder ? '#aaa' : '#08060d'}
          dominantBaseline="middle"
          xmlSpace="preserve"
        >
          <textPath href={`#${pathId}`} startOffset={startOffset}>
            {displayText}
          </textPath>
        </text>
        {debug &&
          segments.map((s, i) => {
            const rad = (s.angle * Math.PI) / 180
            const nx = -Math.sin(rad)
            const ny = Math.cos(rad)
            const offset = halfH + ringGap + 10
            const cx = s.x + nx * offset
            const cy = s.y + ny * offset
            return (
              <circle
                key={i}
                cx={cx}
                cy={cy}
                r={1.2 + s.load * 3.2}
                fill={s.load > 0 ? '#ff4d6d' : '#d8d8d8'}
                opacity={0.85}
              />
            )
          })}
        {focused && caret && (
          <line
            x1={caret.x}
            y1={caret.y - caretH}
            x2={caret.x}
            y2={caret.y + caretH}
            stroke="#08060d"
            strokeWidth={1.5}
            strokeLinecap="round"
            transform={`rotate(${caret.angle} ${caret.x} ${caret.y})`}
            style={{ animation: 'wavy-caret-blink 1.1s ease-in-out infinite' }}
          />
        )}
      </svg>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          updateCursor()
        }}
        onFocus={() => {
          setFocused(true)
          updateCursor()
        }}
        onBlur={() => setFocused(false)}
        onSelect={updateCursor}
        onKeyUp={updateCursor}
        onClick={updateCursor}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: 1,
          height: 1,
          opacity: 0,
          pointerEvents: 'none',
        }}
      />
    </div>
  )
}

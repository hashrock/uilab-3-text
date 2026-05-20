import { useId, useLayoutEffect, useRef, useState } from 'react'

type Props = {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  width?: number
  height?: number
}

export function WavyTextField({
  value,
  onChange,
  placeholder,
  width = 480,
  height = 180,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const pathRef = useRef<SVGPathElement>(null)
  const textRef = useRef<SVGTextElement>(null)
  const measureCanvas = useRef<HTMLCanvasElement | null>(null)
  const [focused, setFocused] = useState(false)
  const [cursorIndex, setCursorIndex] = useState(0)
  const [caret, setCaret] = useState<{ x: number; y: number; angle: number } | null>(
    null,
  )
  type Segment = { x: number; y: number; angle: number; load: number }
  const [segments, setSegments] = useState<Segment[]>([])
  const reactId = useId()
  const pathId = `curve-center-${reactId.replace(/:/g, '')}`

  const padX = 44
  const padY = 32
  const halfH = 22
  const curveAmp = 48
  const steps = 120
  const ringGap = 6
  const fontSize = 18
  const fontFamily = 'system-ui, sans-serif'
  const startOffset = 16
  const segmentCount = 50

  const center = (t: number) => {
    const x = padX + (width - padX * 2) * t
    const y = padY + curveAmp * 4 * t * (1 - t)
    const dx = width - padX * 2
    const dy = curveAmp * 4 * (1 - 2 * t)
    const len = Math.hypot(dx, dy)
    return { x, y, nx: -dy / len, ny: dx / len }
  }

  const centerPathD = (() => {
    const parts: string[] = []
    for (let i = 0; i <= steps; i++) {
      const { x, y } = center(i / steps)
      parts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`)
    }
    return parts.join(' ')
  })()

  const buildRibbon = (h: number) => {
    const topPts: { x: number; y: number }[] = []
    const botPts: { x: number; y: number }[] = []
    for (let i = 0; i <= steps; i++) {
      const { x, y, nx, ny } = center(i / steps)
      topPts.push({ x: x - nx * h, y: y - ny * h })
      botPts.push({ x: x + nx * h, y: y + ny * h })
    }
    const parts: string[] = []
    topPts.forEach((p, i) => {
      parts.push(`${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
    })
    const right = botPts[steps]
    parts.push(`A${h} ${h} 0 0 1 ${right.x.toFixed(2)} ${right.y.toFixed(2)}`)
    for (let i = steps - 1; i >= 0; i--) {
      parts.push(`L${botPts[i].x.toFixed(2)} ${botPts[i].y.toFixed(2)}`)
    }
    const left = topPts[0]
    parts.push(`A${h} ${h} 0 0 1 ${left.x.toFixed(2)} ${left.y.toFixed(2)}`)
    parts.push('Z')
    return parts.join(' ')
  }

  const ribbonD = buildRibbon(halfH)
  const ringD = buildRibbon(halfH + ringGap)

  const measureText = (text: string) => {
    if (!measureCanvas.current) {
      measureCanvas.current = document.createElement('canvas')
    }
    const ctx = measureCanvas.current.getContext('2d')
    if (!ctx) return 0
    ctx.font = `${fontSize}px ${fontFamily}`
    return ctx.measureText(text).width
  }

  useLayoutEffect(() => {
    if (!pathRef.current) {
      setSegments([])
      return
    }
    const path = pathRef.current
    const total = path.getTotalLength()
    const textLen = value && textRef.current ? textRef.current.getComputedTextLength() : 0
    const leading = value.match(/^\s+/)?.[0] ?? ''
    const leadingLen = leading ? measureText(leading) : 0
    const textStart = startOffset + leadingLen
    const textEnd = startOffset + textLen
    const segLen = total / segmentCount
    const eps = 0.5
    const next: Segment[] = []
    for (let i = 0; i < segmentCount; i++) {
      const a = i * segLen
      const b = (i + 1) * segLen
      const overlap = Math.max(0, Math.min(b, textEnd) - Math.max(a, textStart))
      const load = overlap / segLen
      const mid = (a + b) / 2
      const p = path.getPointAtLength(mid)
      const pa = path.getPointAtLength(Math.max(0, mid - eps))
      const pb = path.getPointAtLength(Math.min(total, mid + eps))
      const angle = (Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180) / Math.PI
      next.push({ x: p.x, y: p.y, angle, load })
    }
    setSegments(next)
  }, [value, width, height])

  useLayoutEffect(() => {
    if (!focused || !pathRef.current) {
      setCaret(null)
      return
    }
    const before = value.slice(0, cursorIndex)
    const dist = startOffset + measureText(before)
    const total = pathRef.current.getTotalLength()
    const clamped = Math.max(0, Math.min(dist, total))
    const p = pathRef.current.getPointAtLength(clamped)
    const eps = 0.5
    const pa = pathRef.current.getPointAtLength(Math.max(0, clamped - eps))
    const pb = pathRef.current.getPointAtLength(Math.min(total, clamped + eps))
    const angle = (Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180) / Math.PI
    setCaret({ x: p.x, y: p.y, angle })
  }, [focused, value, cursorIndex])

  const updateCursor = () => {
    if (inputRef.current) {
      setCursorIndex(inputRef.current.selectionStart ?? 0)
    }
  }

  const displayText = value || placeholder || ''
  const isPlaceholder = !value && !!placeholder
  const caretH = 13

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
          <path ref={pathRef} id={pathId} d={centerPathD} fill="none" />
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
          ref={textRef}
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
        {segments.map((s, i) => {
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

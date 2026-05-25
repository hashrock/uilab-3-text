import { useRef } from 'react'

type Props = {
  x: number
  y: number
  xMin: number
  xMax: number
  yMin: number
  yMax: number
  onChange: (x: number, y: number) => void
  size?: number
  labelX?: string
  labelY?: string
}

export function XYPad({
  x,
  y,
  xMin,
  xMax,
  yMin,
  yMax,
  onChange,
  size = 160,
  labelX = 'X',
  labelY = 'Y',
}: Props) {
  const padRef = useRef<HTMLDivElement>(null)

  const update = (clientX: number, clientY: number) => {
    const el = padRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const fx = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    const fy = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
    const nx = xMin + fx * (xMax - xMin)
    const ny = yMin + fy * (yMax - yMin)
    onChange(nx, ny)
  }

  const fx = (x - xMin) / (xMax - xMin)
  const fy = (y - yMin) / (yMax - yMin)
  const handleX = fx * size
  const handleY = fy * size
  const centerX = ((0 - xMin) / (xMax - xMin)) * size
  const centerY = ((0 - yMin) / (yMax - yMin)) * size

  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <div
        ref={padRef}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          update(e.clientX, e.clientY)
        }}
        onPointerMove={(e) => {
          if (e.buttons === 0) return
          update(e.clientX, e.clientY)
        }}
        style={{
          position: 'relative',
          width: size,
          height: size,
          background: '#f5f5f5',
          border: '1px solid #ccc',
          borderRadius: 8,
          cursor: 'crosshair',
          touchAction: 'none',
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: centerY,
            width: '100%',
            height: 1,
            background: '#ddd',
          }}
        />
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: centerX,
            height: '100%',
            width: 1,
            background: '#ddd',
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: handleX - 6,
            top: handleY - 6,
            width: 12,
            height: 12,
            borderRadius: '50%',
            background: '#4a8cff',
            border: '2px solid #fff',
            boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
            pointerEvents: 'none',
          }}
        />
      </div>
      <div style={{ fontSize: 12, color: '#666' }}>
        {labelX}: {x.toFixed(3)} / {labelY}: {y.toFixed(3)}
      </div>
    </div>
  )
}

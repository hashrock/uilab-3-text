import { useEffect, useMemo, useState } from 'react'
import { parseLines, type Font, type Line } from './lib/lff/parser'

const FONT_URL = `${import.meta.env.BASE_URL}kst32b.lff`

function isHankaku(str: string) {
  return /^[\w ',&]+$/.test(str)
}

function charPath(info: Line[], fontSize: number): string {
  const s = fontSize / 10
  let d = ''
  let prev: Line | null = null
  info.forEach((stroke, index) => {
    const x1 = stroke.x1 * s
    const y1 = stroke.y1 * -s + fontSize
    const x2 = stroke.x2 * s
    const y2 = stroke.y2 * -s + fontSize
    if (
      index === 0 ||
      !prev ||
      stroke.x1 !== prev.x2 ||
      stroke.y1 !== prev.y2
    ) {
      d += `M${x1},${y1}`
    }
    d += `L${x2},${y2}`
    prev = stroke
  })
  return d
}

export function LffDemo() {
  const [text, setText] = useState('Hello, LFF!')
  const [fontSize, setFontSize] = useState(48)
  const [kerning, setKerning] = useState(8)
  const [fontMap, setFontMap] = useState<Record<string, Font> | null>(null)
  const [error, setError] = useState<string | null>(null)

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

  const letters = useMemo(() => {
    const out: { letter: string; offset: number }[] = []
    let offset = 0
    for (const letter of text) {
      out.push({ letter, offset })
      offset += isHankaku(letter) ? 0.5 : 1
    }
    return out
  }, [text])

  const advance = fontSize - kerning
  const totalWidth = letters.length
    ? (letters[letters.length - 1].offset + 1) * advance
    : 0
  const padding = 20
  const svgWidth = Math.max(totalWidth + padding * 2, 200)
  const svgHeight = fontSize + padding * 2

  return (
    <div style={{ padding: 24, fontFamily: 'sans-serif' }}>
      <h1 style={{ marginTop: 0 }}>LFF Font Demo</h1>
      <p style={{ color: '#666' }}>
        LibreCAD Font Format (kst32b.lff) をブラウザで描画
      </p>

      <div style={{ display: 'grid', gap: 12, maxWidth: 480, marginBottom: 24 }}>
        <label>
          <div>Text</div>
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            style={{ width: '100%', padding: 8, fontSize: 16 }}
          />
        </label>
        <label>
          <div>Font size: {fontSize}</div>
          <input
            type="range"
            min={12}
            max={120}
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
      </div>

      {error && <div style={{ color: 'crimson' }}>Failed to load font: {error}</div>}
      {!fontMap && !error && <div>Loading font…</div>}

      {fontMap && (
        <svg
          width={svgWidth}
          height={svgHeight}
          style={{ background: '#111', borderRadius: 8 }}
        >
          <g transform={`translate(${padding}, ${padding})`}>
            {letters.map((l, i) => {
              const font = fontMap[l.letter]
              if (!font) return null
              const x = l.offset * advance
              return (
                <g key={i} transform={`translate(${x}, 0)`}>
                  <path
                    d={charPath(font.info, fontSize)}
                    fill="none"
                    stroke="#7af"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                  />
                </g>
              )
            })}
          </g>
        </svg>
      )}
    </div>
  )
}

/**
 * @file web/src/components/atoms/Sparkline.jsx
 * @description SVG sparkline chart for ping history trend visualization.
 * 📖 Renders a polyline with gradient area fill and endpoint dot.
 */
import { useMemo } from 'react'

export default function Sparkline({ history }) {
  const svg = useMemo(() => {
    if (!history || history.length < 2) return null
    const valid = history.filter((p) => p.code === '200' || p.code === '401')
    if (valid.length < 2) return null

    const values = valid.map((p) => p.ms)
    const max = Math.max(...values, 1)
    const min = Math.min(...values, 0)
    const range = max - min || 1
    const w = 80,
      h = 22
    const step = w / (values.length - 1)

    const points = values
      .map((v, i) => {
        const x = i * step
        const y = h - ((v - min) / range) * (h - 4) - 2
        return `${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')

    const lastVal = values[values.length - 1]
    const color = lastVal < 500 ? '#00ff88' : lastVal < 1500 ? '#ffaa00' : '#ff4444'
    const lastX = ((values.length - 1) * step).toFixed(1)
    const lastY = (h - ((lastVal - min) / range) * (h - 4) - 2).toFixed(1)

    return (
      <svg className="sparkline-svg" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
        <polyline fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" points={points} opacity="0.8" />
        <circle cx={lastX} cy={lastY} r="2.5" fill={color} />
      </svg>
    )
  }, [history])

  return svg || null
}

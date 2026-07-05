import React from 'react'
import { Particle } from './particles.jsx'

// Decay picture: parent nucleus on the left → daughter nuclei on the right, one
// arrow each. Same species → same circle (size & colour); per-daughter excitation
// shown under the circle.
export default function DecayDiagram({ parent, daughters, exEnergies }) {
  const ds = (daughters || '').trim().split(/\s+/).filter(Boolean)
  const exs = (exEnergies || '').trim().split(/\s+/).filter((x) => x !== '' && !isNaN(+x))
  const n = Math.max(ds.length, 1)
  const W = 480, H = Math.max(130, n * 56 + 30)
  const px = 72, cx = 360, cy = H / 2
  const ys = ds.map((_, i) => 28 + (i + 0.5) * ((H - 50) / n))
  const lbl = (s, d) => (s && s.trim()) || d
  return (
    <svg className="rxdiag" viewBox={`0 0 ${W} ${H}`}>
      <defs>
        <marker id="rxarrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" className="rxhead" />
        </marker>
      </defs>
      {ds.map((d, i) => (
        <line key={i} x1={px + 24} y1={cy} x2={cx - 26} y2={ys[i]} className="rxout" markerEnd="url(#rxarrow)" />
      ))}
      <Particle name={lbl(parent, 'parent')} x={px} y={cy} />
      {ds.length
        ? ds.map((d, i) => (
            <Particle key={i} name={d} x={cx} y={ys[i]}
              sub={exs[i] && +exs[i] > 0 ? `Ex ${+exs[i]} MeV` : null} />
          ))
        : <text x={cx} y={cy} textAnchor="middle" className="rxnote">생성핵 없음</text>}
      <text x={W / 2} y={H - 6} className="rxnote" textAnchor="middle">
        {lbl(parent, 'X')} → {ds.join(' + ') || '…'}
      </text>
    </svg>
  )
}

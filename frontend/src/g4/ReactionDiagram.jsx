import React from 'react'
import { Particle } from './particles.jsx'

// Two-body reaction picture: every particle is a circle (same species → same size &
// colour). Beam in from the left onto the target, light ejectile up, heavy recoil
// forward; beam energy and excitation states shown under each circle.
export default function ReactionDiagram({ beam, target, light, heavy, exLight, exHeavy, energy }) {
  const W = 480, H = 210, cy = 88
  const bx = 54, tx = 192, px = 400, ly = 54, hy = 134
  const lbl = (s, d) => (s && s.trim()) || d
  const ex = (v) => (v && parseFloat(v) > 0 ? `Ex ${parseFloat(v)} MeV` : null)
  return (
    <svg className="rxdiag" viewBox={`0 0 ${W} ${H}`}>
      <defs>
        <marker id="rxarrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" className="rxhead" />
        </marker>
      </defs>
      {/* arrows */}
      <line x1={bx + 24} y1={cy} x2={tx - 24} y2={cy} className="rxbeam" markerEnd="url(#rxarrow)" />
      <line x1={tx + 16} y1={cy - 8} x2={px - 26} y2={ly + 8} className="rxout" markerEnd="url(#rxarrow)" />
      <line x1={tx + 16} y1={cy + 8} x2={px - 26} y2={hy - 8} className="rxout" markerEnd="url(#rxarrow)" />
      {/* particle circles */}
      <Particle name={lbl(beam, 'beam')} x={bx} y={cy} sub={energy ? `${parseFloat(energy)} MeV` : null} />
      <Particle name={lbl(target, 'target')} x={tx} y={cy} />
      <Particle name={lbl(light, 'light')} x={px} y={ly} sub={ex(exLight)} />
      <Particle name={lbl(heavy, 'heavy')} x={px} y={hy} sub={ex(exHeavy)} />
      {/* notation A(a,b)B */}
      <text x={W / 2} y={H - 6} className="rxnote" textAnchor="middle">
        {lbl(target, 'A')}({lbl(beam, 'a')}, {lbl(light, 'b')}){lbl(heavy, 'B')}
      </text>
    </svg>
  )
}

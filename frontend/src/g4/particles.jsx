// Consistent circle style per particle: same name → same size & colour.
const SPECIAL = {
  proton: 1, p: 1, neutron: 1, n: 1, deuton: 2, deuteron: 2, d: 2,
  triton: 3, t: 3, He3: 3, '3He': 3, alpha: 4, a: 4, gamma: 0, g: 0,
}

export function particleMass(name) {
  const n = (name || '').trim()
  if (SPECIAL[n] != null) return SPECIAL[n]
  const m = n.match(/^(\d+)/)
  return m ? +m[1] : 1
}

export function particleStyle(name) {
  const A = particleMass(name)
  const r = Math.max(8, Math.min(20, 6 + Math.cbrt(A || 1) * 6))
  let h = 0
  for (const c of (name || '?')) h = (h * 33 + c.charCodeAt(0)) % 360
  return { r, color: `hsl(${h} 58% 58%)`, stroke: `hsl(${h} 55% 38%)`, A }
}

// a labelled particle circle (used by the reaction & decay diagrams)
export function Particle({ name, x, y, sub }) {
  const s = particleStyle(name)
  return (
    <g>
      <circle cx={x} cy={y} r={s.r} fill={s.color} stroke={s.stroke} strokeWidth="1.3" />
      <text x={x} y={y + s.r + 13} textAnchor="middle" className="pname">{name || '?'}</text>
      {sub && <text x={x} y={y + s.r + 25} textAnchor="middle" className="psub">{sub}</text>}
    </g>
  )
}

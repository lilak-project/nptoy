import React, { useState } from 'react'
import { PHYSICS_SCHEMA, parsePhysics, serializePhysics, control } from './physics.js'
import { Field } from './formfields.jsx'

// PhysicsListOption.txt form: choice/number options up top, the many 0/1 physics
// toggles as a checkbox grid. Comment/blank lines are preserved untouched.
export default function PhysicsForm({ initialText, onChange }) {
  const [rows, setRows] = useState(() => parsePhysics(initialText))
  const setVal = (i, value) => {
    const next = rows.map((r, j) => (j === i ? { ...r, value } : r))
    setRows(next); onChange(serializePhysics(next))
  }

  const opts = rows.map((r, i) => ({ r, i })).filter((x) => x.r.kind === 'opt')
  const top = opts.filter((x) => control(x.r) === 'choice' || control(x.r) === 'num')
  const toggles = opts.filter((x) => control(x.r) === 'toggle')
  const texts = opts.filter((x) => control(x.r) === 'text')

  return (
    <div className="dform">
      <section className="dblock">
        <div className="dbtitle">Physics</div>
        <div className="dfields">
          {top.map(({ r, i }) => {
            const sp = PHYSICS_SCHEMA[r.key] || { label: r.key }
            const f = sp.type === 'num'
              ? { label: sp.label, type: 'num', n: 1, unit: sp.unit, comment: sp.comment }
              : { label: sp.label || r.key, type: 'choice', choices: sp.choices, comment: sp.comment }
            return <Field key={r.key} f={f} value={r.value} onChange={(v) => setVal(i, v)} />
          })}
          {texts.map(({ r, i }) => (
            <Field key={r.key} f={{ label: r.key, type: 'text' }} value={r.value} onChange={(v) => setVal(i, v)} />
          ))}
        </div>
      </section>

      <section className="dblock">
        <div className="dbtitle">Physics processes <span className="dnote">(on/off)</span></div>
        <div className="toggrid">
          {toggles.map(({ r, i }) => (
            <label key={r.key} className="togrow">
              <input type="checkbox" checked={r.value === '1'}
                onChange={(e) => setVal(i, e.target.checked ? '1' : '0')} />
              <span>{r.key}</span>
            </label>
          ))}
        </div>
      </section>
    </div>
  )
}

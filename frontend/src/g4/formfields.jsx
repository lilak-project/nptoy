import React, { useState } from 'react'
import { splitNum, composeNum, MATERIALS, MATERIAL_COMPOSITION } from './detector.js'

// A parameter label with a clickable ⓘ that toggles its description as a small
// popover — so a field fits on one line ("이름 (i) [입력] 단위") instead of stacking
// the description on its own row. Also hosts the optional remove (×) button.
export function InfoLabel({ label, comment, onRemove }) {
  const [tip, setTip] = useState(false)
  return (
    <span className="dlabel">
      {label}
      {comment && (
        <button type="button" className={`dinfo ${tip ? 'on' : ''}`} title="설명 보기"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setTip((t) => !t) }}>ⓘ</button>
      )}
      {onRemove && (
        <button className="fdel" title="remove field"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRemove() }}>×</button>
      )}
      {tip && comment && (
        <span className="dtip" onClick={(e) => { e.stopPropagation(); setTip(false) }}>{comment}</span>
      )}
    </span>
  )
}

// Shared schema-driven field renderer for the detector / reaction forms. One line:
// label (+ⓘ) on the left, the input control (and unit) filling the rest.
export function Field({ f, value, onChange, onRemove }) {
  // a <div> (not <label>): a <label> dispatches its click to the first labelable
  // descendant, which would trigger the remove (×) button on a title click.
  return (
    <div className="dfield">
      <InfoLabel label={f.label} comment={f.comment} onRemove={onRemove} />
      <div className="dctl">
        {f.type === 'choice' ? (
          <select value={value || f.choices[0]} onChange={(e) => onChange(e.target.value)}>
            {f.choices.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        ) : f.type === 'num' ? (
          <NumInput value={value} n={f.n} unit={f.unit} onChange={onChange} />
        ) : f.type === 'material' ? (
          <>
            <input type="text" value={value} list="np-materials" placeholder="물질 선택/입력"
              onChange={(e) => onChange(e.target.value)} />
            <datalist id="np-materials">
              {MATERIALS.map((m) => <option key={m} value={m} />)}
            </datalist>
            {MATERIAL_COMPOSITION[value] && <span className="matcomp">{MATERIAL_COMPOSITION[value]}</span>}
          </>
        ) : (
          <input type="text" value={value} placeholder={f.comment}
            onChange={(e) => onChange(e.target.value)} />
        )}
      </div>
    </div>
  )
}

export function NumInput({ value, n, unit, onChange }) {
  const { nums, unit: u } = splitNum(value, n, unit)
  const set = (idx, v) => { const next = nums.slice(); next[idx] = v; onChange(composeNum(next, u)) }
  return (
    <span className="dnum">
      {nums.map((x, i) => (
        <input key={i} type="number" value={x} step="any" onChange={(e) => set(i, e.target.value)} />
      ))}
      {u && <span className="dunit">{u}</span>}
    </span>
  )
}

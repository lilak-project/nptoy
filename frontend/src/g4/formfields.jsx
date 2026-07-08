import React, { useEffect, useState } from 'react'
import { splitNum, composeNum, MATERIALS, MATERIAL_COMPOSITION } from './detector.js'

// A number-in-progress: empty, a lone '-', a partial decimal, or scientific notation.
// Using a TEXT input (not type=number) means no spinner arrows AND you can fully clear
// the box / type '-' or the first digit without the browser fighting you.
const _NUM_OK = /^-?\d*\.?\d*(?:[eE][+-]?\d*)?$/

// Shared numeric input: no up/down arrows, freely clearable. Marks itself
// data-empty="1" (+ .empty red border) when blank so a save can flag it.
export function NumberField({ value, onChange, className = '', ...rest }) {
  const empty = String(value ?? '').trim() === ''
  return (
    <input type="text" inputMode="decimal" spellCheck={false}
      className={`numinput ${empty ? 'empty' : ''} ${className}`.trim()}
      data-empty={empty ? '1' : '0'} value={value ?? ''}
      onChange={(e) => { const v = e.target.value; if (_NUM_OK.test(v)) onChange(v) }}
      {...rest} />
  )
}

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

// A group of numbers + optional unit (e.g. a 3-vector "0 0 5 mm"). Keeps its OWN raw
// strings so a field can sit EMPTY while editing — `composeNum` would otherwise turn
// '' back into '0' on the round-trip and refill the box mid-edit. It resyncs from the
// parent only when the parent's value truly differs (e.g. a preset applied elsewhere).
export function NumInput({ value, n, unit, onChange }) {
  const init = splitNum(value, n, unit)
  const [nums, setNums] = useState(init.nums)
  const u = init.unit
  useEffect(() => {
    // only overwrite local edits if the incoming value isn't what we already emitted
    if (composeNum(nums, u) !== String(value ?? '').trim()) setNums(splitNum(value, n, unit).nums)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
  const set = (idx, v) => { const next = nums.slice(); next[idx] = v; setNums(next); onChange(composeNum(next, u)) }
  return (
    <span className="dnum">
      {nums.map((x, i) => (
        <NumberField key={i} value={x} onChange={(v) => set(i, v)} />
      ))}
      {u && <span className="dunit">{u}</span>}
    </span>
  )
}

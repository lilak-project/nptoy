import React, { useMemo, useState } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { NumberField } from './formfields.jsx'

// Generate / edit the differential cross-section file (2 columns: angle[deg] value).
// flat (isotropic), exponential (forward-peaked), gaussian — plus raw text editing.
const SHAPES = [
  { key: 'flat', label: 'flat (isotropic)' },
  { key: 'exp', label: 'exponential decay' },
  { key: 'gauss', label: 'gaussian' },
  { key: 'free', label: 'free (empty — 직접 입력)' },
]

function generate(g) {
  // g fields are raw strings (so the inputs can sit empty / hold '-' mid-edit) — coerce here.
  const N = (x) => { const v = Number(x); return Number.isFinite(v) ? v : 0 }
  const shape = g.shape
  const min = N(g.min), max = N(g.max), step = N(g.step), value = N(g.value)
  const amp = N(g.amp), tau = N(g.tau), mu = N(g.mu), sigma = N(g.sigma)
  const rows = []
  const st = Math.max(Math.abs(step) || 1, 1e-6)
  for (let a = min; a <= max + 1e-9; a += st) {
    const angle = a.toFixed(1)
    if (shape === 'free') { rows.push(`${angle}\t`); continue }   // angles only, values blank
    let v
    if (shape === 'flat') v = value
    else if (shape === 'exp') v = amp * Math.exp(-(a - min) / Math.max(tau, 1e-6))
    else v = amp * Math.exp(-((a - mu) ** 2) / (2 * Math.max(sigma, 1e-6) ** 2))
    rows.push(`${angle}\t${(+v).toPrecision(6)}`)
  }
  return rows.join('\n') + '\n'
}

function parsePoints(text) {
  const pts = []
  for (const ln of (text || '').split('\n')) {
    const f = ln.trim().split(/\s+/)
    if (f.length >= 2 && !isNaN(+f[0]) && !isNaN(+f[1])) pts.push([+f[0], +f[1]])
  }
  return pts
}

// one labelled control: label on top, [input][unit] aligned on the row below
function Field({ label, unit, wide, children, ...rest }) {
  return (
    <label className={`csf${wide ? ' wide' : ''}`}>
      <span className="csfl">{label}</span>
      <span className="csfc">
        {children || <NumberField value={rest.value} onChange={rest.onChange} placeholder={rest.placeholder} />}
        {unit && <i>{unit}</i>}
      </span>
    </label>
  )
}

export default function CrossSectionEditor({ path, value, onChange, files = [], onPick, onSaveAs }) {
  const [g, setG] = useState({
    shape: 'flat', min: 0, max: 180, step: 1, value: 1, amp: 1, tau: 30, mu: 0, sigma: 30,
  })
  const [saveName, setSaveName] = useState('')
  const [grid, setGrid] = useState(true)
  const set = (k, v) => setG((s) => ({ ...s, [k]: v }))
  const num = (k) => (v) => set(k, v)   // NumberField hands us the raw string; generate() coerces
  const apply = () => onChange(generate(g))

  const pts = useMemo(() => parsePoints(value), [value])

  return (
    <div className="cseditor">
      {(files.length > 0 || onSaveAs) && (
        <div className="csfiles">
          <Field label="파일 열기" wide>
            <select className="csfilesel" value={files.includes(path) ? path : ''}
              onChange={(e) => e.target.value && onPick && onPick(e.target.value)}>
              <option value="">{files.includes(path) ? path : `${path || '(현재)'}`}</option>
              {files.filter((f) => f !== path).map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </Field>
          {onSaveAs && (
            <Field label="다른 이름으로 저장" wide>
              <span className="cssaveas">
                <input type="text" value={saveName} placeholder="파일명 (예: my_cs.txt)"
                  onChange={(e) => setSaveName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && saveName.trim() && onSaveAs(saveName.trim())} />
                <button className="sbtn" disabled={!saveName.trim()}
                  onClick={() => onSaveAs(saveName.trim())}>저장</button>
              </span>
            </Field>
          )}
        </div>
      )}

      <div className="csgen">
        <div className="csrow">
          <Field label="shape" wide>
            <select value={g.shape} onChange={(e) => set('shape', e.target.value)}>
              {SHAPES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </Field>
        </div>
        <div className="csrow">
          <Field label="θ min" unit="deg" value={g.min} onChange={num('min')} />
          <Field label="θ max" unit="deg" value={g.max} onChange={num('max')} />
          <Field label="step" unit="deg" value={g.step} step="any" onChange={num('step')} />
          {g.shape === 'flat' && (
            <Field label="value" value={g.value} step="any" onChange={num('value')} />
          )}
          {g.shape === 'exp' && (<>
            <Field label="amplitude" value={g.amp} step="any" onChange={num('amp')} />
            <Field label="decay τ" unit="deg" value={g.tau} step="any" onChange={num('tau')} />
          </>)}
          {g.shape === 'gauss' && (<>
            <Field label="amplitude" value={g.amp} step="any" onChange={num('amp')} />
            <Field label="center μ" unit="deg" value={g.mu} step="any" onChange={num('mu')} />
            <Field label="width σ" unit="deg" value={g.sigma} step="any" onChange={num('sigma')} />
          </>)}
          <button className="sbtn go csgenbtn" onClick={apply}>generate</button>
        </div>
      </div>

      <div className="csplotwrap">
        <div className="csplothead">
          <span className="cslabel">dσ/dΩ vs θ ({pts.length} pts)</span>
          <label className="csgrid"><input type="checkbox" checked={grid}
            onChange={(e) => setGrid(e.target.checked)} /> grid</label>
        </div>
        <Plot pts={pts} grid={grid} />
      </div>

      <div className="csbody">
        <div className="cslabel">angle[deg] · dσ/dΩ ({pts.length} points) → {path}</div>
        <textarea value={value} spellCheck={false}
          onChange={(e) => onChange(e.target.value)} />
      </div>
    </div>
  )
}

const numFmt = (v) => {
  const a = Math.abs(v)
  if (a !== 0 && (a < 0.001 || a >= 1e4)) return v.toExponential(1)
  return String(Math.round(v * 1000) / 1000)
}

// Fixed-height responsive line chart (recharts) — same style as the elog data tab:
// labelled x/y axes with tick values, optional grid, hover tooltip.
function Plot({ pts, grid }) {
  if (pts.length < 2) return <div className="csplot empty">데이터 없음 — generate 하세요.</div>
  const data = pts.map(([x, y]) => ({ x, y }))
  const tick = { fontSize: 11, fill: '#334155' }   // darker tick labels
  const axis = { stroke: '#7c8aa0' }               // darker axis lines
  return (
    <div className="csplot">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 10, right: 22, left: 8, bottom: 24 }}>
          {grid && <CartesianGrid stroke="#aab5c4" strokeDasharray="2 3" strokeWidth={1} />}
          <XAxis dataKey="x" type="number" domain={['dataMin', 'dataMax']} tick={tick} tickCount={13}
            tickLine={axis} axisLine={axis} tickFormatter={numFmt}
            label={{ value: 'θ [deg]', position: 'insideBottom', offset: -12, fontSize: 12, fill: '#334155' }} />
          <YAxis tick={tick} tickCount={11} tickLine={axis} axisLine={axis} width={58} tickFormatter={numFmt}
            label={{ value: 'dσ/dΩ', angle: -90, position: 'insideLeft', offset: 14, fontSize: 12, fill: '#334155' }} />
          <Tooltip isAnimationActive={false}
            contentStyle={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 6, fontSize: 11 }}
            labelFormatter={(v) => `θ = ${numFmt(v)}°`} formatter={(v) => [numFmt(v), 'dσ/dΩ']} />
          <Line type="monotone" dataKey="y" stroke="#e08514" strokeWidth={1.8} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

import React, { useState } from 'react'

// AnalysisSetup — edits the "analysis setup" slot: a list of plots to pre-draw when a
// .root output is opened in the Files tab. Persists as analysis.json in the workspace
// (so presets & saves carry it). Emits the JSON text via onChange, like the other
// editors; the parent handles dirty/save.
const BLANK = { title: '', x: '', y: '', cut: '', opt: '', nx: '', xlo: '', xhi: '', ny: '', ylo: '', yhi: '' }

export default function AnalysisSetup({ initialText, onChange }) {
  const parse = (t) => {
    try { const o = JSON.parse(t || '{}'); return Array.isArray(o.plots) ? o.plots : [] }
    catch { return [] }
  }
  const [plots, setPlots] = useState(() => parse(initialText))
  const emit = (next) => { setPlots(next); onChange(JSON.stringify({ plots: next }, null, 2)) }
  const upd = (i, k, v) => emit(plots.map((p, j) => (j === i ? { ...p, [k]: v } : p)))
  const add = () => emit([...plots, { ...BLANK }])
  const del = (i) => emit(plots.filter((_, j) => j !== i))

  return (
    <div className="anlist">
      <div className="andesc">
        Files 탭에서 .root 파일을 열면 여기서 정의한 그림들을 바로 그릴 수 있습니다.
        X는 <code>분기.멤버</code>, Y를 채우면 2D 히스토그램입니다.
      </div>
      {plots.map((p, i) => (
        <div className="ancard" key={i}>
          <div className="anrow anhead">
            <input className="antitle" value={p.title} placeholder={`plot ${i + 1}`}
              onChange={(e) => upd(i, 'title', e.target.value)} />
            <button className="anrm" title="삭제" onClick={() => del(i)}>✕</button>
          </div>
          <div className="anrow">
            <label>X<input value={p.x} onChange={(e) => upd(i, 'x', e.target.value)} placeholder="분기.멤버" /></label>
            <label>Y<input value={p.y} onChange={(e) => upd(i, 'y', e.target.value)} placeholder="(2D)" /></label>
          </div>
          <div className="anrow">
            <label style={{ flex: 2 }}>Cut<input value={p.cut} onChange={(e) => upd(i, 'cut', e.target.value)} placeholder="예: E>0" /></label>
            <label>Opt<input value={p.opt} onChange={(e) => upd(i, 'opt', e.target.value)} placeholder={p.y?.trim() ? 'colz' : 'hist'} /></label>
          </div>
          <div className="anrow anbins">
            <span>X 구간</span>
            <input value={p.nx} onChange={(e) => upd(i, 'nx', e.target.value)} placeholder="N" />
            <input value={p.xlo} onChange={(e) => upd(i, 'xlo', e.target.value)} placeholder="min" />
            <input value={p.xhi} onChange={(e) => upd(i, 'xhi', e.target.value)} placeholder="max" />
          </div>
          {p.y && p.y.trim() && (
            <div className="anrow anbins">
              <span>Y 구간</span>
              <input value={p.ny} onChange={(e) => upd(i, 'ny', e.target.value)} placeholder="N" />
              <input value={p.ylo} onChange={(e) => upd(i, 'ylo', e.target.value)} placeholder="min" />
              <input value={p.yhi} onChange={(e) => upd(i, 'yhi', e.target.value)} placeholder="max" />
            </div>
          )}
        </div>
      ))}
      {!plots.length && <div className="dnote">아직 정의된 그림이 없습니다. 아래에서 추가하세요.</div>}
      <button className="sbtn go anadd" onClick={add}>＋ 그림 추가</button>
    </div>
  )
}

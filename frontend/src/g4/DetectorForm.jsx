import React, { useEffect, useMemo, useState } from 'react'
import {
  DETECTOR_BLOCKS, parseDetector, serializeDetector, fieldSpec, newBlock,
  detectCombo, switchCombo, detectVariant, switchVariant, getParam,
  specFromCatalog, newBlockFromSpec,
} from './detector.js'
import { Field } from './formfields.jsx'
import { geomCatalog } from './api.js'

const ADDABLE = ['Target', 'ATOMX', 'STARK', 'CSSU', 'Coaxial_Germanium', 'Plunger', 'ASGARD']
const defaultFor = (f) => f.default ?? (f.type === 'num'
  ? Array(f.n).fill('0').join(' ') + (f.unit ? ' ' + f.unit : '')
  : f.type === 'choice' ? f.choices[0] : '')

// detectors.json fetched once per page (the generated per-detector schema —
// hand-tuned DETECTOR_BLOCKS entries stay authoritative, the catalog covers
// every other simulatable detector with typed fields + descriptions).
let _catalogPromise = null
const loadCatalog = () => (_catalogPromise ||= geomCatalog().catch(() => null))

export default function DetectorForm({ initialText, onChange }) {
  const [blocks, setBlocks] = useState(() => parseDetector(initialText))
  const [catalog, setCatalog] = useState(null)
  useEffect(() => { loadCatalog().then(setCatalog) }, [])
  // token → converted spec for every simulatable catalog detector that has no
  // hand-tuned entry (Volume/Solid belong to the Geometry tab's editor)
  const catalogSpecs = useMemo(() => {
    const out = {}
    for (const [token, entry] of Object.entries(catalog?.detectors || {})) {
      if (!entry.simulation || DETECTOR_BLOCKS[token] || token === 'Volume' || token === 'Solid') continue
      out[token] = specFromCatalog(token, entry)
    }
    return out
  }, [catalog])
  const specFor = (type) => DETECTOR_BLOCKS[type] || catalogSpecs[type]
  const fieldOf = (type, key) => fieldSpec(type, key) || catalogSpecs[type]?.fields.find((f) => f.key === key)
  const [confirmClear, setConfirmClear] = useState(false)
  const [collapsed, setCollapsed] = useState(() => new Set())         // collapsed block indices
  const [groupCollapsed, setGroupCollapsed] = useState(() => new Set())  // collapsed detector types
  const toggleBlock = (bi) =>
    setCollapsed((s) => { const n = new Set(s); n.has(bi) ? n.delete(bi) : n.add(bi); return n })
  const toggleGroup = (t) =>
    setGroupCollapsed((s) => { const n = new Set(s); n.has(t) ? n.delete(t) : n.add(t); return n })

  const commit = (next) => { setBlocks(next); onChange(serializeDetector(next)) }
  const mutate = (bi, fn) => commit(blocks.map((b, i) => {
    if (i !== bi) return b
    const nb = { ...b, params: b.params.map((p) => ({ ...p })) }
    fn(nb); return nb
  }))

  const hasATOMX = blocks.some((b) => b.type === 'ATOMX')
  const setVal = (bi, key, value) => mutate(bi, (nb) => {
    const p = nb.params.find((x) => x.key === key)
    if (p) p.value = value; else nb.params.push({ key, value })
  })
  const removeField = (bi, key) => mutate(bi, (nb) => { nb.params = nb.params.filter((p) => p.key !== key) })
  const addField = (bi, key) =>
    mutate(bi, (nb) => { const f = fieldOf(blocks[bi].type, key); nb.params.push({ key, value: f ? defaultFor(f) : '' }) })
  const applyPreset = (bi, set) => mutate(bi, (nb) =>
    Object.entries(set).forEach(([k, v]) => {
      const p = nb.params.find((x) => x.key === k); if (p) p.value = v; else nb.params.push({ key: k, value: v })
    }))
  const setCombo = (bi, combo) => mutate(bi, (nb) => { nb.params = switchCombo(blocks[bi].type, nb, combo) })
  const setVariant = (bi, variant) => mutate(bi, (nb) => { nb.params = switchVariant(blocks[bi].type, nb, variant) })
  const setArg = (bi, arg) => commit(blocks.map((b, i) => (i === bi ? { ...b, arg } : b)))
  const addBlock = (type) => commit([...blocks,
    DETECTOR_BLOCKS[type] ? newBlock(type, { hasATOMX }) : newBlockFromSpec(type, catalogSpecs[type])])
  const removeBlock = (bi) => { setCollapsed(new Set()); commit(blocks.filter((_, i) => i !== bi)) }
  const clearAll = () => {                          // inline 2-step confirm
    if (!confirmClear) { setConfirmClear(true); return }
    setConfirmClear(false); commit([])
  }
  const has = (type) => blocks.some((b) => b.type === type)

  // Group blocks by detector type (preserving each type's first appearance), keeping
  // the original index so edits/removes still target the right block.
  const groups = []
  blocks.forEach((b, bi) => {
    let g = groups.find((x) => x.type === b.type)
    if (!g) { g = { type: b.type, items: [] }; groups.push(g) }
    g.items.push({ b, bi })
  })

  // One detector box. `num` (1-based) is shown as a badge when the type repeats.
  const renderBlock = (b, bi, num) => {
    const spec = specFor(b.type)
    const presentKeys = new Set(b.params.map((p) => p.key))
    let addable = (spec?.fields || []).filter((f) => !presentKeys.has(f.key))
    // for a variant block (CSSU), only offer the current shape's params (+ X/Y/Z
    // as an alternative to POS) — not every other shape's fields.
    if (spec?.variants) {
      const allow = new Set([...spec.variants[detectVariant(b.type, b)].keys, 'X', 'Y', 'Z'])
      addable = addable.filter((f) => allow.has(f.key))
    }
    const col = collapsed.has(bi)
    return (
      <section className={`dblock ${col ? 'collapsed' : ''}`} key={bi}>
        <div className="dbhead">
          <button className="dbcaret" title={col ? '펼치기' : '접기'}
            onClick={() => toggleBlock(bi)}>{col ? '▶' : '▾'}</button>
          <span className="dbtitle" onClick={() => toggleBlock(bi)}>
            {num != null && <span className="dbnum">#{num}</span>}
            {spec ? spec.label : b.type}{!spec && ' (unknown)'}
          </span>
          {spec?.hasArg && (
            <input className="arginput" value={b.arg || ''} placeholder={spec.arg?.label}
              title={spec.arg?.comment} onChange={(e) => setArg(bi, e.target.value)} />
          )}
          {spec?.combos && (
            <select className="comboSel" value={detectCombo(b.type, b)}
              onChange={(e) => setCombo(bi, e.target.value)} title="파라미터 조합">
              {Object.entries(spec.combos).map(([k, c]) => <option key={k} value={k}>{c.label}</option>)}
            </select>
          )}
          {spec?.variants && (
            <select className="comboSel" value={detectVariant(b.type, b)}
              onChange={(e) => setVariant(bi, e.target.value)} title="검출기 형상 (Type)">
              {Object.entries(spec.variants).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          )}
          <button className="solo" title="remove block" onClick={() => removeBlock(bi)}>✕</button>
        </div>

        {!col && (<>
          {spec?.presets && Object.entries(spec.presets).map(([k, list]) => (
            <div className="dpreset" key={k}>
              <span>{k} preset</span>
              <div className="presetbtns">
                {list.map((p) => {
                  const on = Object.entries(p.set).every(([kk, vv]) => getParam(b, kk).trim() === vv)
                  return (
                    <button key={p.label} type="button" className={`pbtn ${on ? 'on' : ''}`}
                      onClick={() => applyPreset(bi, p.set)}>{p.label}</button>
                  )
                })}
              </div>
            </div>
          ))}

          <div className="dfields">
            {spec?.fromCatalog && spec.description && (
              <div className="dnote" style={{ padding: '2px 10px 6px', lineHeight: 1.45 }}>{spec.description}</div>
            )}
            {b.params.map((p) => {
              // the variant key (CSSU Type) is driven by the header selector, not an inline field
              if (spec?.variants && p.key === spec.variantKey) return null
              const f = fieldOf(b.type, p.key) || { key: p.key, label: p.key, type: 'text' }
              return <Field key={p.key} f={f} value={p.value}
                onChange={(v) => setVal(bi, p.key, v)} onRemove={() => removeField(bi, p.key)} />
            })}
          </div>

          {addable.length > 0 && (
            <div className="daddfield">
              <select value="" onChange={(e) => { if (e.target.value) addField(bi, e.target.value) }}>
                <option value="" disabled>+ 필드 추가…</option>
                {addable.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
              </select>
            </div>
          )}
        </>)}
      </section>
    )
  }

  return (
    <div className="dform detform">
      <div className="dtoolbar">
        <span className="dnote">add:</span>
        {ADDABLE.map((t) => (
          <button key={t} className="reload" disabled={DETECTOR_BLOCKS[t].single && has(t)}
            onClick={() => addBlock(t)}>+ {t}</button>
        ))}
        {Object.keys(catalogSpecs).length > 0 && (
          <select value="" title="nptool의 모든 검출기 (detectors.json 카탈로그에서 자동 생성)"
            style={{ fontSize: 12, maxWidth: 150 }}
            onChange={(e) => { if (e.target.value) addBlock(e.target.value) }}>
            <option value="" disabled>+ 전체 검출기…</option>
            {Object.keys(catalogSpecs).sort().map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
        <button className="reload danger" onClick={clearAll} disabled={!blocks.length}
          onMouseLeave={() => setConfirmClear(false)}>{confirmClear ? '정말 지울까요?' : 'clear all'}</button>
      </div>

      {blocks.length > 0 && (
        <div className="dsummary">
          <span className="dslabel">검출기 구성</span>
          {groups.map((g) => (
            <span className="dschip" key={g.type}>{g.type}<b>×{g.items.length}</b></span>
          ))}
          <span className="dstotal">총 {blocks.length}개</span>
        </div>
      )}

      {groups.map((g) => {
        const multi = g.items.length > 1
        const gcol = groupCollapsed.has(g.type)
        return (
          <div className="dgroup" key={g.type}>
            {multi && (
              <button className="dghead" onClick={() => toggleGroup(g.type)}>
                <span className="dgcaret">{gcol ? '▶' : '▾'}</span>
                <span className="dgname">{g.type} 그룹</span>
                <span className="dgcount">×{g.items.length}</span>
                <span className="dghint">{gcol ? '전체 펴기' : '전체 접기'}</span>
              </button>
            )}
            {!gcol && g.items.map(({ b, bi }, idx) => renderBlock(b, bi, multi ? idx + 1 : null))}
          </div>
        )
      })}

      {!blocks.length && <div className="dnote">검출기 블록이 없습니다. 위에서 추가하세요.</div>}
    </div>
  )
}

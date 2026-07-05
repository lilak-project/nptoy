import React, { useEffect, useState } from 'react'
import {
  REACTION_BLOCKS, parseReaction, serializeReaction, newReactionBlock,
} from './reaction.js'
import { getParam, setParam } from './detector.js'
import { Field, InfoLabel } from './formfields.jsx'
import ReactionDiagram from './ReactionDiagram.jsx'
import DecayDiagram from './DecayDiagram.jsx'

// Structured reaction editor: Beam (required, first) → reaction → optional Decay.
// `csFiles` = available cross-section files for the CrossSectionPath dropdown.
const ADDABLE = ['Beam', 'TwoBodyReaction', 'Isotropic', 'Decay']

export default function ReactionForm({ initialText, onChange, csFiles = [] }) {
  const [blocks, setBlocks] = useState(() => parseReaction(initialText))
  const commit = (next) => { setBlocks(next); onChange(serializeReaction(next)) }

  function setField(bi, key, value) {
    commit(blocks.map((b, i) => {
      if (i !== bi) return b
      const nb = { ...b, params: b.params.map((p) => ({ ...p })) }
      setParam(nb, key, value)
      return nb
    }))
  }
  const setArg = (bi, arg) => commit(blocks.map((b, i) => (i === bi ? { ...b, arg } : b)))
  const addBlock = (type) => commit([...blocks, newReactionBlock(type)])
  const removeBlock = (bi) => commit(blocks.filter((_, i) => i !== bi))
  const clearAll = () => { if (window.confirm('모든 반응 블록을 지웁니다. 계속할까요?')) commit([]) }
  const has = (type) => blocks.some((b) => b.type === type)

  // Auto-fill an empty CrossSectionPath with the first available CS file.
  useEffect(() => {
    if (!csFiles.length) return
    const i = blocks.findIndex((b) => b.type === 'TwoBodyReaction')
    if (i >= 0 && !getParam(blocks[i], 'CrossSectionPath').trim()) {
      setField(i, 'CrossSectionPath', `${csFiles[0]} CS`)
    }
  }, [csFiles])

  const beamE = getParam(blocks.find((b) => b.type === 'Beam') || { params: [] }, 'Energy')
  const unknown = blocks.filter((b) => !REACTION_BLOCKS[b.type])
  const csFileOf = (v) => (v || '').trim().split(/\s+/)[0] || ''

  return (
    <div className="dform">
      <div className="dtoolbar">
        <span className="dnote">add:</span>
        {ADDABLE.map((t) => (
          <button key={t} className="reload" disabled={REACTION_BLOCKS[t].single && has(t)}
            onClick={() => addBlock(t)}>+ {REACTION_BLOCKS[t].label}</button>
        ))}
        <button className="reload danger" onClick={clearAll} disabled={!blocks.length}>clear all</button>
      </div>

      {blocks.map((b, bi) => {
        const spec = REACTION_BLOCKS[b.type]
        if (!spec) return null
        return (
          <section className="dblock" key={bi}>
            <div className="dbhead">
              <span className="dbtitle">
                {spec.label}
                {spec.arg && (
                  <input className="arginput" value={b.arg} placeholder={spec.arg.label}
                    title={spec.arg.comment} onChange={(e) => setArg(bi, e.target.value)} />
                )}
              </span>
              {spec.repeatable && (
                <button className="solo" title="remove" onClick={() => removeBlock(bi)}>✕</button>
              )}
            </div>

            {b.type === 'TwoBodyReaction' && (
              <ReactionDiagram beam={getParam(b, 'Beam')} target={getParam(b, 'Target')}
                light={getParam(b, 'Light')} heavy={getParam(b, 'Heavy')}
                exLight={getParam(b, 'ExcitationEnergyLight')} exHeavy={getParam(b, 'ExcitationEnergyHeavy')}
                energy={beamE} />
            )}
            {b.type === 'Decay' && (
              <DecayDiagram parent={b.arg} daughters={getParam(b, 'Daughter')}
                exEnergies={getParam(b, 'ExcitationEnergy')} />
            )}

            <div className="dfields">
              {spec.fields.map((f) => {
                const value = getParam(b, f.key)
                if (f.key === 'CrossSectionPath' && csFiles.length) {
                  const cur = csFileOf(value)
                  return (
                    <div className="dfield" key={f.key}>
                      <InfoLabel label={f.label} comment={f.comment} />
                      <div className="dctl">
                        <select value={csFiles.includes(cur) ? cur : ''}
                          onChange={(e) => setField(bi, f.key, e.target.value ? `${e.target.value} CS` : '')}>
                          <option value="">(직접 입력)</option>
                          {csFiles.map((p) => <option key={p} value={p}>{p}</option>)}
                        </select>
                        {!csFiles.includes(cur) && (
                          <input type="text" value={value} placeholder={f.comment}
                            onChange={(e) => setField(bi, f.key, e.target.value)} />
                        )}
                      </div>
                    </div>
                  )
                }
                return <Field key={f.key} f={f} value={value} onChange={(v) => setField(bi, f.key, v)} />
              })}
            </div>
          </section>
        )
      })}

      {!blocks.length && <div className="dnote">반응 블록이 없습니다. 위에서 추가하세요.</div>}
      {unknown.length > 0 && (
        <div className="dnote warn">⚠ 폼에 없는 블록 {unknown.length}개 — text 모드에서 편집하세요.</div>
      )}
    </div>
  )
}

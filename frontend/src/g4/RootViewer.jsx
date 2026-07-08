import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CaretRight } from '@phosphor-icons/react'
import { fetchFileObject, rootDraw, rootSave, inputsGetFile } from './api.js'

/**
 * RootViewer — the ROOT workspace for a .root file opened in the Files tab.
 *
 * It renders in TWO places:
 *   • a CONTROL box (left, an individual panel like the file browser): branch tree +
 *     draw form + buttons. Shown when `controlOpen`; closed via `onCloseControl`.
 *   • the PLOTS, portalled into `plotHost` (the wide preview area on the right) so they
 *     stay put even when the control box is toggled shut.
 *
 * JSROOT can read the file's structure (keys, tree, streamer infos) but CANNOT stream
 * nptool's unsplit custom detector objects — it misaligns and crashes. So we split it:
 *   • CLIENT (JSROOT): open the file, list each branch's drawable members from the
 *     streamer info, draw file-level histograms it CAN read.
 *   • SERVER (sci-runner, real ROOT): TTree::Draw an expression — 1D, or 2D "vary:varx"
 *     with a cut and explicit binning — → histogram JSON, parsed & drawn here.
 */
const OBJ_GROUP = '__objects__'

export default function RootViewer({ path, controlOpen = true, plotHost = null, onCloseControl, onCloseViewer, onSaved }) {
  const [status, setStatus] = useState('여는 중…')
  const [err, setErr] = useState('')
  const [groups, setGroups] = useState([])       // [{ branch, members:[{label,expr,type}] }]
  const [objects, setObjects] = useState([])     // client-drawable top-level keys
  const [nEntries, setNEntries] = useState(null) // number of events (tree entries)
  const [openGroups, setOpenGroups] = useState(new Set())  // expanded branch names (default collapsed)
  const [drawErr, setDrawErr] = useState('')
  const [drawLog, setDrawLog] = useState('')     // last draw: expr {cut} → N entries (or error)

  // draw form
  const [f, setF] = useState({ vx: '', vy: '', cut: '', opt: '', nx: '', xlo: '', xhi: '', ny: '', ylo: '', yhi: '' })
  const [armed, setArmed] = useState(null)       // 'x'|'y' = a member click only FILLS that axis (waits
                                                 // for 그리기); null = a member click quick-draws 1D at once

  // plots (one per draw) + view mode
  const [plots, setPlots] = useState([])         // [{ id, title, option, obj, error, loading, seq }]
  const [activePlot, setActivePlot] = useState(0)
  const [grid, setGrid] = useState(false)
  const [saved, setSaved] = useState([])         // pre-configured plots from the analysis setup

  const jsrootRef = useRef(null)
  const fileRef = useRef(null)
  const treeRef = useRef('SimulatedTree')
  const idRef = useRef(0)
  const seqRef = useRef(0)
  const drawnRef = useRef(new Map())             // plot id → last-drawn seq

  useEffect(() => {
    let cancelled = false
    setNEntries(null)
    ;(async () => {
      try {
        const [jsroot, file] = await Promise.all([import('jsroot'), fetchFileObject(path)])
        if (cancelled) return
        jsrootRef.current = jsroot
        const rfile = await jsroot.openFile(file)
        if (cancelled) return
        fileRef.current = rfile

        const si = {}
        for (const s of (rfile.fStreamerInfos?.arr || [])) si[s.fName] = s
        const membersOf = (cls) => {
          const s = si[cls]
          if (!s) return []
          return (s.fElements?.arr || [])
            .filter((e) => e._typename !== 'TStreamerBase' && !/string/i.test(e.fTypeName || ''))
            .map((e) => ({ label: e.fName, type: e.fTypeName }))
        }

        const drawableKey = (c) => /^TH[123]|^TGraph|^TProfile|^TCanvas/.test(c || '')
        const objs = (rfile.fKeys || [])
          .filter((k) => drawableKey(k.fClassName))
          .map((k) => ({ name: `${k.fName};${k.fCycle}`, label: k.fName, cls: k.fClassName }))

        const grp = []
        const treeKey = (rfile.fKeys || []).find((k) => k.fClassName === 'TTree')
        if (treeKey) {
          treeRef.current = treeKey.fName
          const tree = await rfile.readObject(`${treeKey.fName};${treeKey.fCycle}`)
          if (cancelled) return
          setNEntries(typeof tree.fEntries === 'number' ? tree.fEntries : null)
          for (const b of (tree.fBranches?.arr || [])) {
            const cls = b.fClassName || b.fClonesName
            if (cls) {
              const mems = []
              for (const m of membersOf(cls)) {
                const base = `${b.fName}.${m.label}`
                // a TVector3 (or vector<TVector3>) can't be drawn as-is → expose its x/y/z
                // components as separate draw expressions (verified: `branch.member.fX` works).
                if (/TVector3/.test(m.type || '')) {
                  for (const [ax, sub] of [['x', 'fX'], ['y', 'fY'], ['z', 'fZ']])
                    mems.push({ label: `${m.label}.${ax}`, type: m.type, expr: `${base}.${sub}` })
                } else {
                  mems.push({ label: m.label, type: m.type, expr: base })
                }
              }
              if (mems.length) grp.push({ branch: b.fName, members: mems })
            } else {
              grp.push({ branch: b.fName, members: [{ label: b.fName, type: 'leaf', expr: b.fName }] })
            }
          }
        }
        if (cancelled) return
        setObjects(objs)
        setGroups(grp)
        setOpenGroups(objs.length ? new Set([OBJ_GROUP]) : new Set())  // branches collapsed; objects open
        setStatus('')
      } catch (e) {
        if (!cancelled) setErr(String(e?.message || e))
      }
    })()
    return () => {
      cancelled = true
      const j = jsrootRef.current
      if (j) for (const id of drawnRef.current.keys()) { try { j.cleanup('rv-plot-' + id) } catch {} }
    }
  }, [path])

  // Draw/resize each VISIBLE plot's DOM. Draw once (when its object first appears or
  // changes → seq bump); thereafter just resize so tab-switching/grid-toggling refits
  // the already-rendered SVG instead of re-parsing.
  useEffect(() => {
    const jsroot = jsrootRef.current
    if (!jsroot) return
    ;(async () => {
      for (const p of plots) {
        if (!p.obj) continue
        const visible = grid || p.id === activePlot
        if (!visible) continue
        const dom = document.getElementById('rv-plot-' + p.id)
        if (!dom) continue
        if (drawnRef.current.get(p.id) !== p.seq) {
          try { await jsroot.cleanup(dom) } catch {}
          try { await jsroot.draw(dom, p.obj, p.option); drawnRef.current.set(p.id, p.seq) } catch (e) { /* per-plot */ }
        } else {
          try { jsroot.resize(dom) } catch {}
        }
      }
    })()
  }, [plots, activePlot, grid, controlOpen, plotHost])

  function buildHist(form) {
    const xset = form.nx && form.xlo !== '' && form.xhi !== ''
    const yset = form.ny && form.ylo !== '' && form.yhi !== ''
    if (form.vy.trim()) return xset && yset ? `${form.nx},${form.xlo},${form.xhi},${form.ny},${form.ylo},${form.yhi}` : ''
    return xset ? `${form.nx},${form.xlo},${form.xhi}` : ''
  }

  async function addPlot(newTab, title, option, producer, spec = null) {
    const replaceId = !newTab && plots.some((p) => p.id === activePlot) ? activePlot : null
    const id = replaceId ?? ++idRef.current
    setActivePlot(id)
    setPlots((prev) => {
      const base = { id, title, option, obj: null, error: '', loading: true, spec }
      return replaceId ? prev.map((p) => (p.id === id ? { ...p, ...base } : p))
        : [...prev, { ...base, seq: 0 }]
    })
    const cutTxt = spec?.cut ? ` {${spec.cut}}` : ''
    try {
      const obj = await producer()
      const seq = ++seqRef.current
      const ne = (obj && typeof obj.fEntries === 'number') ? obj.fEntries : '?'
      setDrawLog(`✓ ${title}${cutTxt} → ${ne} entries`)
      setPlots((prev) => prev.map((p) => (p.id === id ? { ...p, obj, loading: false, seq } : p)))
    } catch (e) {
      setDrawLog(`✗ ${title}${cutTxt} → ${String(e?.message || e)}`)
      setPlots((prev) => prev.map((p) => (p.id === id ? { ...p, loading: false, error: String(e?.message || e) } : p)))
    }
  }

  async function drawWith(form, newTab) {
    setDrawErr('')
    const vx = form.vx.trim()
    if (!vx) { setDrawErr('X 변수를 선택하세요.'); return }
    const vy = form.vy.trim()
    const expr = vy ? `${vy}:${vx}` : vx
    const hist = buildHist(form)
    const option = form.opt.trim() || (vy ? 'colz' : 'hist')
    const cut = form.cut.trim()
    await addPlot(newTab, expr, option, async () => {
      const jsonStr = await rootDraw(path, treeRef.current, expr, cut, hist)
      return jsrootRef.current.parse(jsonStr)
    }, { tree: treeRef.current, expr, cut, hist })
  }

  // 초기화: clear the X/Y assignment (and disarm the axis buttons).
  function resetAxes() { setF((p) => ({ ...p, vx: '', vy: '' })); setArmed(null); setDrawErr('') }

  // 임시저장: write the active plot to a .root file under the user's root/ dir
  // (sibling of output/). Server re-runs the TTree::Draw and TFile::Write it.
  const [saving, setSaving] = useState(false)
  async function tempSave() {
    const p = plots.find((x) => x.id === activePlot)
    if (!p || !p.spec) { setDrawErr('임시저장할 그림이 없습니다 (트리에서 그린 그림만 저장됩니다).'); return }
    const base = (p.title || 'canvas').replace(/[^A-Za-z0-9_.:+\-]+/g, '_').slice(0, 40) || 'canvas'
    setSaving(true); setDrawErr('')
    try {
      const r = await rootSave(path, p.spec.tree, p.spec.expr, p.spec.cut, p.spec.hist, base)
      onSaved && onSaved(r && r.path)
      setDrawErr('저장됨 — root/' + (r?.name || base + '.root'))
    } catch (e) { setDrawErr('저장 실패: ' + String(e?.message || e)) }
    finally { setSaving(false) }
  }

  // Click a branch member. If an axis is armed (X/Y button), only fill that field and
  // wait for the 그리기 button. Otherwise it's a quick look: set X and draw 1D at once.
  function pickMember(expr) {
    if (armed === 'x') { setF((p) => ({ ...p, vx: expr })); return }
    if (armed === 'y') { setF((p) => ({ ...p, vy: expr })); return }
    const nf = { ...f, vx: expr }
    setF(nf)
    drawWith(nf, false)
  }

  function drawFileObject(name, label) {
    setDrawErr('')
    addPlot(false, label, '', async () => fileRef.current.readObject(name))
  }

  // Pre-configured plots from the analysis setup (Setup tab). Draw one — or all — as tabs.
  useEffect(() => {
    let ok = true
    inputsGetFile('analysis').then((r) => {
      try { const o = JSON.parse(r.content || '{}'); if (ok && Array.isArray(o.plots)) setSaved(o.plots) } catch {}
    }).catch(() => {})
    return () => { ok = false }
  }, [])
  const drawSaved = (p) => drawWith({
    vx: p.x || '', vy: p.y || '', cut: p.cut || '', opt: p.opt || '',
    nx: p.nx || '', xlo: p.xlo || '', xhi: p.xhi || '', ny: p.ny || '', ylo: p.ylo || '', yhi: p.yhi || '',
  }, true)

  function closePlot(id, e) {
    e.stopPropagation()
    const j = jsrootRef.current
    try { j?.cleanup('rv-plot-' + id) } catch {}
    drawnRef.current.delete(id)
    setPlots((prev) => {
      const rest = prev.filter((p) => p.id !== id)
      if (id === activePlot) setActivePlot(rest.length ? rest[rest.length - 1].id : 0)
      return rest
    })
  }

  const toggleGroup = (name) => setOpenGroups((prev) => {
    const n = new Set(prev); n.has(name) ? n.delete(name) : n.add(name); return n
  })
  const upd = (k) => (e) => setF((prev) => ({ ...prev, [k]: e.target.value }))

  const is2D = !!f.vy.trim()

  // ── plots (portalled into the preview area) ─────────────────────────────
  const plotsUI = (
    <div className="rootplots">
      <div className="rvfilebar">
        <span className="rvfilename" title={path}>{path.split('/').pop()}</span>
        {onCloseViewer && <button className="rvfileclose" onClick={onCloseViewer} title="ROOT 뷰어 닫기 (파일 미리보기로 복귀)">✕</button>}
      </div>
      {plots.length > 0 && !grid && (
        <div className="rvtabs">
          {plots.map((p) => (
            <button key={p.id} className={`rvtab ${p.id === activePlot ? 'on' : ''}`}
              onClick={() => setActivePlot(p.id)} title={p.title}>
              <span className="rvtabtxt">{p.title}</span>
              <span className="rvtabx" onClick={(e) => closePlot(p.id, e)}>×</span>
            </button>
          ))}
        </div>
      )}
      {drawErr && <div className="rvderr">⚠ {drawErr}</div>}
      {drawLog && <div className="rvdrawlog" title="마지막 그리기 로그">{drawLog}</div>}
      {err && <div className="rvderr">⚠ 파일을 열지 못했습니다: {err}</div>}
      <div className={grid ? 'rvgrid' : 'rvstack'}>
        {plots.map((p) => {
          const visible = grid || p.id === activePlot
          return (
            <div key={p.id} className={grid ? 'rvcell' : 'rvscell'} style={{ display: visible ? 'flex' : 'none' }}>
              {grid && (
                <div className="rvcap"><span className="rvcaptxt" title={p.title}>{p.title}</span>
                  <span className="rvtabx" onClick={(e) => closePlot(p.id, e)}>×</span></div>
              )}
              {p.error ? <div className="rvderr">⚠ {p.error}</div> : <div id={'rv-plot-' + p.id} className="rvdom" />}
              {p.loading && <div className="rvloading">그리는 중…</div>}
            </div>
          )
        })}
        {!plots.length && (
          <div className="rvhint">{status || (controlOpen
            ? '오른쪽 컨트롤에서 항목을 클릭하거나 X/Y·컷·구간을 정해 “그리기”를 누르세요.'
            : 'ROOT 컨트롤을 열어 히스토그램을 그리세요.')}</div>
        )}
      </div>
    </div>
  )

  // ── control box (left panel) ────────────────────────────────────────────
  const controlUI = (
    <div className="filespanel rootctrl">
      <div className="fphead">
        <span className="fptitle">ROOT 컨트롤</span>
        {onCloseControl && <button className="fpclose" onClick={onCloseControl} title="닫기">✕</button>}
      </div>
      {saved.length > 0 && (
        <div className="rvsaved">
          <div className="rvsavedhead">
            <span>저장된 그림</span>
            <button onClick={() => saved.forEach(drawSaved)} title="모두 새 탭으로 그리기">모두</button>
          </div>
          <div className="rvsavedlist">
            {saved.map((p, i) => (
              <button key={i} className="rvsavedbtn" onClick={() => drawSaved(p)}
                title={`${p.y ? p.y + ':' : ''}${p.x}${p.cut ? '  {' + p.cut + '}' : ''}`}>
                {p.title || p.x || `plot ${i + 1}`}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="rvform">
        {/* draw actions on top (그리기/새탭/격자/초기화/임시저장) */}
        <div className="rvbtns">
          <button className="rvbtn" onClick={() => drawWith(f, false)}>그리기</button>
          <button className="rvbtn alt" onClick={() => drawWith(f, true)}>＋ 새 탭</button>
          <button className={`rvbtn alt ${grid ? 'on' : ''}`} onClick={() => setGrid((g) => !g)}
            disabled={plots.length < 2} title="여러 히스토그램을 격자로 보기">▦ 격자</button>
          <button className="rvbtn alt" onClick={resetAxes} title="X · Y 지정값을 지웁니다">초기화</button>
          <button className="rvbtn alt" onClick={tempSave} disabled={saving || !plots.some((p) => p.id === activePlot && p.spec)}
            title="현재 그림을 root/ 폴더에 .root 파일로 임시저장">{saving ? '저장 중…' : '임시저장'}</button>
        </div>
        <div className="rvfrow">
          <label className="rvfld">
            <button className={`rvax ${armed === 'x' ? 'on' : ''}`} onClick={() => setArmed((a) => (a === 'x' ? null : 'x'))}
              title="X축 지정: 항목을 클릭하면 즉시 그리지 않고 X에만 넣습니다">X 지정</button>
            <input value={f.vx} onChange={upd('vx')} placeholder="분기.멤버" className={armed === 'x' ? 'on' : ''} />
          </label>
          <label className="rvfld">
            <button className={`rvax ${armed === 'y' ? 'on' : ''}`} onClick={() => setArmed((a) => (a === 'y' ? null : 'y'))}
              title="Y축 지정 (2D): 항목을 클릭하면 Y에만 넣습니다">Y 지정</button>
            <input value={f.vy} onChange={upd('vy')} placeholder="(2D)" className={armed === 'y' ? 'on' : ''} />
          </label>
        </div>
        <div className="rvfrow">
          <label className="rvfld" style={{ flex: 2 }}>Cut<input value={f.cut} onChange={upd('cut')} placeholder="예: E>0" /></label>
          <label className="rvfld">Opt<input value={f.opt} onChange={upd('opt')} placeholder={is2D ? 'colz' : 'hist'} /></label>
        </div>
        <div className="rvbins">
          <span className="rvbinlbl">X 구간</span>
          <input value={f.nx} onChange={upd('nx')} placeholder="N" />
          <input value={f.xlo} onChange={upd('xlo')} placeholder="min" />
          <input value={f.xhi} onChange={upd('xhi')} placeholder="max" />
        </div>
        {is2D && (
          <div className="rvbins">
            <span className="rvbinlbl">Y 구간</span>
            <input value={f.ny} onChange={upd('ny')} placeholder="N" />
            <input value={f.ylo} onChange={upd('ylo')} placeholder="min" />
            <input value={f.yhi} onChange={upd('yhi')} placeholder="max" />
          </div>
        )}
        {armed && <div className="rvarm">{armed.toUpperCase()}축 지정 중 · 항목 고르고 ‘그리기’</div>}
      </div>

      <div className="rvtree">
        {status && <div className="rvstatus">{status}</div>}
        {nEntries != null && <div className="rventries">이벤트 {nEntries.toLocaleString()}개</div>}
        {objects.length > 0 && (
          <Group name={OBJ_GROUP} label="객체" open={openGroups.has(OBJ_GROUP)} onToggle={toggleGroup}>
            {objects.map((o) => (
              <button key={o.name} className="rvitem" onClick={() => drawFileObject(o.name, o.label)} title={o.cls}>
                {o.label} <span className="rvtype">{o.cls}</span>
              </button>
            ))}
          </Group>
        )}
        {groups.map((g) => (
          <Group key={g.branch} name={g.branch} label={g.branch} open={openGroups.has(g.branch)} onToggle={toggleGroup}>
            {g.members.map((m) => (
              <button key={m.expr} className="rvitem" onClick={() => pickMember(m.expr)} title={m.expr}>
                {m.label} <span className="rvtype">{m.type}</span>
              </button>
            ))}
          </Group>
        ))}
        {!status && !err && !groups.length && !objects.length && (
          <div className="rvstatus">그릴 수 있는 항목이 없습니다.</div>
        )}
        {err && <div className="rvderr">⚠ {err}</div>}
      </div>
    </div>
  )

  return (
    <>
      {controlOpen && controlUI}
      {plotHost && createPortal(plotsUI, plotHost)}
    </>
  )
}

function Group({ name, label, open, onToggle, children }) {
  return (
    <div className="rvgroup">
      <button className="rvghead" onClick={() => onToggle(name)}>
        <CaretRight size={12} weight="bold" style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }} />
        <span className="rvgname">{label}</span>
      </button>
      {open && <div>{children}</div>}
    </div>
  )
}

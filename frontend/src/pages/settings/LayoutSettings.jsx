import { useEffect, useState } from 'react'
import { LayoutEditor, useLang } from 'lilak-ui'
import { get, put as apiPut, post } from '../../api'

// Manager-only tab editor. Edits the SAME /api/layout config the Shell reads (and
// the portal Manage UI edits) — structure only (which top-level tabs show + their
// order/labels/icons/hidden). The panel behind each tab is code (Shell.jsx PAGES),
// so nptoy's rich in-tab rails (setup/geometry/simulation/files) are untouched.
export default function LayoutSettings() {
  const { t } = useLang()
  const [cfg, setCfg] = useState(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)

  useEffect(() => { get('/api/layout').then(setCfg).catch(() => setCfg({ tabs: [] })) }, [])

  const save = async () => {
    setSaving(true); setErr(null)
    try { const r = await apiPut('/api/layout', cfg); setCfg(r); setDirty(false) }
    catch (e) { setErr(String(e.message || e)) }
    finally { setSaving(false) }
  }
  const reset = async () => {
    setErr(null)
    try { const r = await post('/api/layout/reset'); setCfg(r); setDirty(false) }
    catch (e) { setErr(String(e.message || e)) }
  }

  if (!cfg) return null
  return (
    <div style={{ maxWidth: 720 }}>
      <h3 style={{ margin: '0 0 4px' }}>{t('set_tabs')}</h3>
      <p style={{ margin: '0 0 14px', color: 'var(--text-muted)', fontSize: 'var(--fs-small, 12px)' }}>
        상단 탭의 표시·순서·이름·아이콘을 편집합니다. 변경은 모든 사용자에게 적용됩니다.
        (탭 내부 메뉴는 각 탭의 코드에서 관리됩니다.)
      </p>
      {err && <div style={{ color: 'var(--danger-text, #b91c1c)', fontSize: 'var(--fs-small, 12px)', marginBottom: 10 }}>{err}</div>}
      <LayoutEditor value={cfg} onChange={(c) => { setCfg(c); setDirty(true) }} onSave={save} onReset={reset} dirty={dirty} saving={saving} />
    </div>
  )
}

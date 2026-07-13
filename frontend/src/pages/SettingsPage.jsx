import { useEffect, useState } from 'react'
import { SideNav, useLang } from 'lilak-ui'
import { get } from '../api'
import AccountSection from './settings/AccountSection'
import ManageUsers from './settings/ManageUsers'
import LayoutSettings from './settings/LayoutSettings'
import AdminTab from '../g4/AdminTab.jsx'

// Reorder / hide the settings sections per the tab's codeMenu (Settings 탭 editor).
// Sections stay code-owned; the config only carries order + hidden by id.
function applyOrder(items, cfg) {
  if (!Array.isArray(cfg) || !cfg.length) return items
  const hidden = new Set(cfg.filter((m) => m.hidden).map((m) => m.id))
  const order = cfg.map((m) => m.id)
  const rank = (id) => { const i = order.indexOf(id); return i < 0 ? order.length : i }
  return items.filter((s) => !hidden.has(s.id)).sort((a, b) => rank(a.id) - rank(b.id))
}

// Portal-centric Settings: account + user management come from the portal;
// tabs / profile-types are service-local stubs to fill in.
export default function SettingsPage({ menuConfig }) {
  const { t } = useLang()
  const [me, setMe] = useState(null)
  useEffect(() => { get('/api/whoami').then(setMe).catch(() => setMe({ authenticated: false })) }, [])

  const isManager = me?.role === 'manager'
  const sections = applyOrder([
    { id: 'account', label: t('set_account'), icon: 'user', group: 'me' },
    { id: 'users', label: t('set_users'), icon: 'users', group: 'people' },
    ...(isManager ? [
      { id: 'limits', label: '사용자 한도', icon: 'gauge', group: 'appearance' },
      { id: 'tabs', label: t('set_tabs'), icon: 'browse', group: 'appearance' },
    ] : []),
  ], menuConfig)
  const [active, setActive] = useState('account')
  const cur = sections.some((s) => s.id === active) ? active : sections[0]?.id

  // Page wrapper gives the outer margin + centring (AppShell mounts pages flush);
  // SideNav supplies its own right gap, so the content column has no extra padding.
  return (
    <div style={{ maxWidth: 1180, margin: '0 auto', padding: '16px 16px 40px' }}>
      <div style={{ display: 'flex', minHeight: 500 }}>
        <SideNav title={t('tab_set')} sections={sections} active={cur} onSelect={setActive} />
        <div style={{ flex: 1, minWidth: 0 }}>
          {cur === 'account' && <AccountSection me={me} />}
          {cur === 'users' && <ManageUsers />}
          {cur === 'limits' && <AdminTab />}
          {cur === 'tabs' && <LayoutSettings />}
        </div>
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { SideNav, useLang } from 'lilak-ui'
import { get } from '../api'
import AccountSection from './settings/AccountSection'
import ManageUsers from './settings/ManageUsers'
import ServiceLocal from './settings/ServiceLocal'
import AdminTab from '../g4/AdminTab.jsx'

// Portal-centric Settings: account + user management come from the portal;
// tabs / profile-types are service-local stubs to fill in.
export default function SettingsPage() {
  const { t } = useLang()
  const [me, setMe] = useState(null)
  useEffect(() => { get('/api/whoami').then(setMe).catch(() => setMe({ authenticated: false })) }, [])

  const isManager = me?.role === 'manager'
  const sections = [
    { id: 'account', label: t('set_account'), icon: 'user', group: 'me' },
    { id: 'users', label: t('set_users'), icon: 'users', group: 'people' },
    ...(isManager ? [
      { id: 'limits', label: '사용자 한도', icon: 'gauge', group: 'appearance' },
      { id: 'tabs', label: t('set_tabs'), icon: 'browse', group: 'appearance' },
      { id: 'profiles', label: t('set_profiles'), icon: 'user', group: 'appearance' },
    ] : []),
  ]
  const [active, setActive] = useState('account')

  // Page wrapper gives the outer margin + centring (AppShell mounts pages flush);
  // SideNav supplies its own right gap, so the content column has no extra padding.
  return (
    <div style={{ maxWidth: 1180, margin: '0 auto', padding: '16px 16px 40px' }}>
      <div style={{ display: 'flex', minHeight: 500 }}>
        <SideNav title={t('tab_set')} sections={sections} active={active} onSelect={setActive} />
        <div style={{ flex: 1, minWidth: 0 }}>
          {active === 'account' && <AccountSection me={me} />}
          {active === 'users' && <ManageUsers />}
          {active === 'limits' && <AdminTab />}
          {active === 'tabs' && <ServiceLocal title={t('set_tabs')} />}
          {active === 'profiles' && <ServiceLocal title={t('set_profiles')} />}
        </div>
      </div>
    </div>
  )
}

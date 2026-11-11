import { Stack, Row, Button, useLang } from 'lilak-ui'
import { portalHome } from '../../api'

const card = { border: '1px solid var(--dock-border-default)', backgroundColor: 'var(--dock-surface)', borderRadius: 12, boxShadow: '0 1px 2px rgba(0,0,0,.04)', padding: 20 }

// Portal-centric account view: show the SSO profile; account + password are
// managed in the portal.
export default function AccountSection({ me }) {
  const { t } = useLang()
  const isManager = me?.role === 'manager'
  const row = (k, v) => (
    <div style={{ display: 'flex', gap: 12, fontSize: 'var(--fs-small, 12px)' }}>
      <span style={{ width: 84, color: 'var(--dock-text-muted)' }}>{k}</span>
      <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--dock-text-primary)' }}>{v || '—'}</span>
    </div>
  )
  return (
    <Stack gap={16} style={{ maxWidth: 384 }}>
      <Stack gap={14} style={card}>
        <Row gap={10} align="center">
          <p style={{ margin: 0, fontWeight: 600, fontSize: 'var(--fs-large, 16px)', color: 'var(--dock-text-primary)' }}>{me?.name || me?.username || 'guest'}</p>
          {me?.role && (
            <span style={{ fontSize: 'var(--fs-small, 12px)', padding: '1px 8px', borderRadius: 999, fontWeight: 500,
              ...(isManager ? { backgroundColor: 'var(--dock-warning-bg)', color: 'var(--dock-warning-text)' } : { backgroundColor: 'var(--dock-surface-2)', color: 'var(--dock-text-secondary)' }) }}>{me.role}</span>
          )}
        </Row>
        <Stack gap={8} style={{ paddingTop: 12, borderTop: '1px solid var(--dock-border-subtle)' }}>
          {row('username', me?.username)}
          {row('email', me?.email)}
        </Stack>
        <div style={{ fontSize: 'var(--fs-tiny, 11px)', color: 'var(--dock-text-muted)' }}>{t('set_account_note')}</div>
        <Button variant="secondary" onClick={() => { window.location.href = portalHome() }} style={{ width: '100%', padding: '8px 0' }}>{t('set_open_portal')}</Button>
      </Stack>
    </Stack>
  )
}

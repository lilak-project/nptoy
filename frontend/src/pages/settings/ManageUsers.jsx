import { Stack, Button, useLang } from 'lilak-ui'
import { portalHome } from '../../api'

const card = { border: '1px solid var(--border-default)', backgroundColor: 'var(--surface)', borderRadius: 12, boxShadow: '0 1px 2px rgba(0,0,0,.04)', padding: 20 }

// Portal owns accounts + permissions, so user management links out to the portal.
export default function ManageUsers() {
  const { t } = useLang()
  return (
    <Stack gap={16} style={{ maxWidth: 384 }}>
      <Stack gap={12} style={card}>
        <p style={{ margin: 0, fontWeight: 600, fontSize: 'var(--fs-body, 13px)', color: 'var(--text-primary)' }}>{t('set_users')}</p>
        <div style={{ fontSize: 'var(--fs-small, 12px)', color: 'var(--text-muted)' }}>{t('set_users_note')}</div>
        <Button variant="secondary" onClick={() => { window.location.href = portalHome() }} style={{ width: '100%', padding: '8px 0' }}>{t('set_open_portal')}</Button>
      </Stack>
    </Stack>
  )
}

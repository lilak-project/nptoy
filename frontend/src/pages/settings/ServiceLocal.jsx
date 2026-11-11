import { Stack, Callout, useLang } from 'lilak-ui'

// Placeholder for a service-local admin section (tabs / profile types). Replace
// with a real editor backed by this service's own endpoints when needed.
export default function ServiceLocal({ title }) {
  const { t } = useLang()
  return (
    <Stack gap={12} style={{ maxWidth: 520 }}>
      <p style={{ margin: 0, fontWeight: 600, fontSize: 'var(--fs-body, 13px)', color: 'var(--dock-text-primary)' }}>{title}</p>
      <Callout tone="info">{t('set_service_local')}</Callout>
    </Stack>
  )
}

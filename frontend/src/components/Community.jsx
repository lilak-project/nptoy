/**
 * Community — nptoy's chat tab now runs the SHARED kit <Community> (same feature
 * set as the zii service: 시간순/광장 views, questions, polls, anon, 공지, moderation)
 * against nptoy's /api/community/* backend (the reusable community.py module).
 *
 * Wired via ../community_api (adapter) + the portal role/onOpenFiles from Shell.
 */
import { Community as KitCommunity } from 'lilak-ui'
import { communityApi } from '../community_api'

export default function Community({ role = 'user', onOpenFiles, active = true }) {
  return (
    <div style={{ height: '100%', boxSizing: 'border-box', padding: 12 }}>
      <KitCommunity
        api={communityApi}
        role={role}
        onOpenFiles={onOpenFiles}
        active={active}
        storageKey="nptoy"
        features={{ attachments: true, questions: true, anon: true, polls: true, mentions: true, moderation: true }}
      />
    </div>
  )
}

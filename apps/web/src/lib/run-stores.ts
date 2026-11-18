import { host } from '@/host'

/**
 * For a route loader: resolves once the run's log has been read as far as it went when asked,
 * so a page drawn from it arrives whole instead of saying "Connecting" and filling in as events
 * land. After a few seconds it goes ahead regardless. Never rejects: a page can always be shown
 * and fill in.
 */
export function whenRunSynced(runId: string, userId: string): Promise<void> {
  return host.whenRunSynced(runId, userId)
}

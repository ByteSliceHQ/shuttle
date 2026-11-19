import { personalWorkspaceRunId, workspaceRunId } from '../config'
import type { EngineEnv } from '../env'
import { isPublicSession, type SessionAccess } from './access'

/**
 * The workspace runs that list a session, which is where its title, status and activity are
 * sent. A public session is listed in the organization's workspace. A private one is listed only
 * in the personal workspaces of its owner and the people it is shared with, so nobody else ever
 * receives an event about it.
 */
export function listingRunIds(
  env: EngineEnv,
  orgId: string,
  access: SessionAccess | null,
): string[] {
  if (!access || isPublicSession(access) || access.ownerId === null) {
    return [workspaceRunId(env, orgId)]
  }

  return [access.ownerId, ...access.memberIds].map((userId) =>
    personalWorkspaceRunId(env, orgId, userId),
  )
}

/** What changes in the listings when a session's access goes from `before` to `after`. */
export function listingChanges(
  env: EngineEnv,
  orgId: string,
  before: SessionAccess | null,
  after: SessionAccess | null,
) {
  const old = listingRunIds(env, orgId, before)
  const next = listingRunIds(env, orgId, after)

  return {
    added: next.filter((runId) => !old.includes(runId)),
    removed: old.filter((runId) => !next.includes(runId)),
    kept: next.filter((runId) => old.includes(runId)),
  }
}

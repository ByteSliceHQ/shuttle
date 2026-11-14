import type { EventInput } from '@swirls/looms/core'

import { ensureNamedWorkspace } from '../bootstrap'
import type { ShuttleEnv } from '../env'
import { loomsStub } from '../looms-stub'
import type { SessionAccess } from '../tenancy/access'
import { listingChanges, listingRunIds } from '../tenancy/listings'
import type { SessionActivity } from './scope'
import { listSession, shareSession, unlistSession } from './signals'

/** A session as a workspace's tree shows it. */
export interface ListedSession {
  readonly runId: string
  readonly folderId: string
  readonly goal: string
  readonly title: string
  readonly status: string
  readonly activity: SessionActivity
  readonly createdAt: number
  readonly updatedAt: number
  readonly archived: boolean
}

interface WorkspaceTreeBody {
  readonly value?: { readonly sessions?: Readonly<Record<string, Partial<ListedSession>>> }
}

const ACTIVITIES: readonly SessionActivity[] = ['idle', 'working', 'needs_input', 'error']

/** The session's entry in the first of `workspaceRunIds` that lists it. */
export async function readListedSession(
  env: ShuttleEnv,
  workspaceRunIds: readonly string[],
  sessionRunId: string,
): Promise<ListedSession | null> {
  for (const workspaceRunId of workspaceRunIds) {
    const response = await loomsStub(env.LOOMS_RUN, workspaceRunId).fetch(
      new Request(`https://shuttle.internal/runs/${workspaceRunId}/projections/workspaceTree`),
    )

    if (!response.ok) {
      continue
    }

    const entry = ((await response.json()) as WorkspaceTreeBody).value?.sessions?.[sessionRunId]

    if (entry && typeof entry.folderId === 'string') {
      return {
        runId: sessionRunId,
        folderId: entry.folderId,
        goal: entry.goal ?? '',
        title: entry.title ?? entry.goal ?? '',
        status: entry.status ?? 'running',
        activity: ACTIVITIES.find((activity) => activity === entry.activity) ?? 'idle',
        createdAt: entry.createdAt ?? 0,
        updatedAt: entry.updatedAt ?? 0,
        archived: entry.archived ?? false,
      }
    }
  }

  return null
}

/** Sends `events` to every workspace that lists the session. */
export async function signalListings(
  env: ShuttleEnv,
  orgId: string,
  access: SessionAccess | null,
  events: readonly EventInput[],
): Promise<void> {
  await Promise.all(
    listingRunIds(env, orgId, access).map((workspaceRunId) =>
      loomsStub(env.LOOMS_RUN, workspaceRunId).signal(events),
    ),
  )
}

/**
 * Moves a session between listings after its access changed from `before` to `after`: it appears
 * in the workspaces that now list it, disappears from the ones that no longer do, and the ones
 * that still list it learn the new members.
 */
export async function moveListings(
  env: ShuttleEnv,
  orgId: string,
  sessionRunId: string,
  before: SessionAccess | null,
  after: SessionAccess,
): Promise<void> {
  const { added, removed, kept } = listingChanges(env, orgId, before, after)
  const memberIds = [...after.memberIds]

  const listed =
    added.length > 0 ? await readListedSession(env, [...kept, ...removed], sessionRunId) : null

  await Promise.all([
    ...added.map(async (workspaceRunId) => {
      if (!listed) {
        return
      }

      await ensureNamedWorkspace(env, workspaceRunId)

      await loomsStub(env.LOOMS_RUN, workspaceRunId).signal([
        listSession({ ...listed, ownerId: after.ownerId, memberIds }),
      ])
    }),
    ...kept.map((workspaceRunId) =>
      loomsStub(env.LOOMS_RUN, workspaceRunId).signal([
        shareSession({ runId: sessionRunId, memberIds }),
      ]),
    ),
  ])

  // Removed last, so a session that is moving is never listed nowhere.
  await Promise.all(
    removed.map((workspaceRunId) =>
      loomsStub(env.LOOMS_RUN, workspaceRunId).signal([unlistSession({ runId: sessionRunId })]),
    ),
  )
}

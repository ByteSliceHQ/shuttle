import { z } from 'zod'

import type { EventInput } from '@swirls/looms/core'

import { ensureNamedWorkspace } from '../bootstrap'
import type { EngineEnv } from '../env'
import { loomsStub } from '../looms-stub'
import type { SessionAccess } from '../tenancy/access'
import { listingChanges, listingRunIds } from '../tenancy/listings'
import type { SessionActivity } from '../workspace/scope'
import { listSession, shareSession, unlistSession } from '../workspace/signals'

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

const WorkspaceTreeBodySchema = z.object({
  value: z
    .object({
      sessions: z
        .record(
          z.string(),
          z.object({
            folderId: z.string().optional(),
            goal: z.string().optional(),
            title: z.string().optional(),
            status: z.string().optional(),
            activity: z.string().optional(),
            createdAt: z.number().optional(),
            updatedAt: z.number().optional(),
            archived: z.boolean().optional(),
          }),
        )
        .nullish(),
    })
    .nullish(),
})

const ACTIVITIES: readonly SessionActivity[] = ['idle', 'working', 'needs_input', 'error']

/** The session's entry in the first of `workspaceRunIds` that lists it. */
export async function readListedSession(
  env: EngineEnv,
  workspaceRunIds: readonly string[],
  sessionRunId: string,
): Promise<ListedSession | null> {
  return (await readListedSessions(env, workspaceRunIds, [sessionRunId])).get(sessionRunId) ?? null
}

/**
 * Each session's entry in the first of `workspaceRunIds` that lists it, reading each workspace's
 * tree once, all at the same time, however many sessions are asked for. A session no workspace
 * lists is left out.
 */
export async function readListedSessions(
  env: EngineEnv,
  workspaceRunIds: readonly string[],
  sessionRunIds: readonly string[],
): Promise<Map<string, ListedSession>> {
  const found = new Map<string, ListedSession>()
  const wanted = new Set(sessionRunIds)

  // Every workspace is read at once; the first in `workspaceRunIds` that lists a session wins.
  const trees = await Promise.all(
    workspaceRunIds.map(async (workspaceRunId) => {
      const response = await loomsStub(env.LOOMS_RUN, workspaceRunId).fetch(
        new Request(`https://shuttle.internal/runs/${workspaceRunId}/projections/workspaceTree`),
      )

      if (!response.ok) {
        return undefined
      }

      const body = WorkspaceTreeBodySchema.safeParse(await response.json())

      return body.success ? (body.data.value?.sessions ?? undefined) : undefined
    }),
  )

  for (const sessions of trees) {
    for (const sessionRunId of wanted) {
      const entry = sessions?.[sessionRunId]

      if (found.has(sessionRunId) || entry?.folderId === undefined) {
        continue
      }

      found.set(sessionRunId, {
        runId: sessionRunId,
        folderId: entry.folderId,
        goal: entry.goal ?? '',
        title: entry.title ?? entry.goal ?? '',
        status: entry.status ?? 'running',
        activity: ACTIVITIES.find((activity) => activity === entry.activity) ?? 'idle',
        createdAt: entry.createdAt ?? 0,
        updatedAt: entry.updatedAt ?? 0,
        archived: entry.archived ?? false,
      })
    }
  }

  return found
}

/** Sends `events` to every workspace that lists the session. */
export async function signalListings(
  env: EngineEnv,
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
  env: EngineEnv,
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

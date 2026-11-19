import { ORPCError } from '@orpc/server'
import { z } from 'zod'

import {
  SessionTabsState,
  WorkspaceFolder,
  WorkspaceTree,
  type FolderSyncReport,
  type LinkedRepo,
  type WorkspaceSnapshot,
} from '@shuttle/api'
import { deleteAsset, putAsset, uploadMediaType, type AssetRef } from '@shuttle/engine/assets/store'
import {
  ensureNamedWorkspace,
  ensurePlaybookQuietly,
  ensurePullsQuietly,
  ensureWorkspaceQuietly,
} from '@shuttle/engine/bootstrap'
import {
  personalWorkspaceRunId,
  playbookRunId,
  pullsRunId,
  workspaceRunId,
} from '@shuttle/engine/config'
import { loomsStub } from '@shuttle/engine/looms-stub'
import { syncFolderRepos } from '@shuttle/engine/pulls/folder-sync'
import type { AutoReviewMode } from '@shuttle/engine/pulls/scope'
import {
  linkReviewSession,
  setRepoPolicy,
  setThreadResolution,
  upsertComment,
} from '@shuttle/engine/pulls/signals'
import { syncPullThreads } from '@shuttle/engine/pulls/thread-sync'
import type { Actor, SessionAccess } from '@shuttle/engine/tenancy/access'
import { scopedRunId } from '@shuttle/engine/tenancy/run-id'
import {
  linkRepo,
  reportActivity,
  requestSession,
  unlinkRepo,
} from '@shuttle/engine/workspace/module'
import { getInstallation, listInstallationRepos } from '@shuttle/git/github/app'
import {
  commentOnLine,
  getPullRequest,
  replyToThread,
  setThreadResolved,
} from '@shuttle/git/github/pulls'
import { DEVICE_ID } from '@shuttle/runner-protocol'

import { getAuth } from '../auth/auth'
import type { ShuttleEnv } from '../env'
import { GITHUB_NOT_CONNECTED, githubTokenOf } from '../github/user-token'
import { installationConnected } from '../tenancy/installations'
import { api, badRequest, notFound } from './base'

const workspace = api.workspace

/** A Looms projection's answer: the projected value, absent while nothing has been projected. */
function projectionOf<Value extends z.ZodType>(value: Value) {
  return z.object({ value: value.nullish() })
}

const FoldersProjection = projectionOf(
  z.object({
    folders: z
      .record(z.string(), WorkspaceFolder.pick({ repos: true, autoReview: true }))
      .optional(),
  }),
)

const PlaybookProjection = projectionOf(
  z.object({
    version: z.number().optional(),
    lessons: z
      .array(z.object({ id: z.string(), text: z.string(), scope: z.string().optional() }))
      .optional(),
  }),
)

async function readWorkspace(
  env: ShuttleEnv,
  runId: string,
  ctx?: ExecutionContext,
): Promise<WorkspaceSnapshot> {
  const stub = loomsStub(env.LOOMS_RUN, runId)

  const [treeResponse, tabsResponse, tail] = await Promise.all([
    stub.fetch(
      new Request(`https://shuttle.internal/runs/${runId}/projections/workspaceTree`, {
        method: 'GET',
      }),
    ),
    stub.fetch(
      new Request(`https://shuttle.internal/runs/${runId}/projections/sessionTabs`, {
        method: 'GET',
      }),
    ),
    stub.getStreamTail(),
  ])

  // Both are checked against the contract on the way out.
  const treeBody = treeResponse.ok
    ? projectionOf(WorkspaceTree).parse(await treeResponse.json())
    : null

  const tabsBody = tabsResponse.ok
    ? projectionOf(SessionTabsState).parse(await tabsResponse.json())
    : null

  ctx?.waitUntil(reconcileActiveWorkspaceSessions(env, runId, treeBody?.value ?? undefined))

  return {
    runId,
    tail,
    tree: treeBody?.value ?? null,
    tabs: tabsBody?.value ?? null,
  }
}

async function reconcileActiveWorkspaceSessions(
  env: ShuttleEnv,
  workspaceId: string,
  initialTree?: WorkspaceTree,
): Promise<void> {
  try {
    const stub = loomsStub(env.LOOMS_RUN, workspaceId)
    let tree = initialTree

    if (tree === undefined) {
      const response = await stub.fetch(
        new Request(`https://shuttle.internal/runs/${workspaceId}/projections/workspaceTree`, {
          method: 'GET',
        }),
      )

      if (!response.ok) {
        return
      }

      // This runs beside the response, so a tree that does not match the contract is skipped
      // here rather than failing anything.
      const body = projectionOf(WorkspaceTree).safeParse(await response.json())

      if (!body.success) {
        return
      }

      tree = body.data.value ?? undefined
    }

    const activeSessions = Object.values(tree?.sessions ?? {}).flatMap((session) =>
      session.status === 'running' && session.activity === 'working'
        ? [
            {
              runId: session.runId,
              activitySeq: session.activitySeq,
              updatedAt: session.updatedAt,
            },
          ]
        : [],
    )

    if (activeSessions.length === 0) {
      return
    }

    const corrections = await Promise.allSettled(
      activeSessions.map(async (entry) => {
        const snapshot = await loomsStub(env.LOOMS_RUN, entry.runId).getSessionActivitySnapshot()

        if (!snapshot || snapshot.tail === 0 || snapshot.activity === 'working') {
          return null
        }

        const seq = Math.max(snapshot.tail, entry.activitySeq ?? 0)
        const at = entry.updatedAt > 0 ? entry.updatedAt : Date.now()

        const built = reportActivity({
          runId: entry.runId,
          activity: snapshot.activity,
          at,
          seq,
        })

        return {
          ...built,
          idempotencyKey: `reconcile:${entry.runId}:${seq}:${snapshot.activity}`,
        }
      }),
    )

    const signals = corrections.flatMap((result) =>
      result.status === 'fulfilled' && result.value !== null ? [result.value] : [],
    )

    if (signals.length > 0) {
      await stub.signal(signals)
    }
  } catch {
    // Best-effort background reconciliation; live sessions still self-report via projectors.
  }
}

function privateTo(actor: Actor): SessionAccess {
  return { ownerId: actor.userId, memberIds: [], visibility: 'private' }
}

/** Pulls every open pull request on a folder's repositories. Null when there is no such folder. */
async function syncPullsOfFolder(
  env: ShuttleEnv,
  orgId: string,
  folderId: string,
): Promise<FolderSyncReport | null> {
  await ensureWorkspaceQuietly(env, orgId)
  await ensurePullsQuietly(env, orgId)

  const tree = await readWorkspaceFolders(env, orgId)
  const folder = tree.folders[folderId]

  if (!folder) {
    return null
  }

  const pullsStub = loomsStub(env.LOOMS_RUN, pullsRunId(env, orgId))

  return syncFolderRepos(env, pullsStub, folderId, folder.repos)
}

/**
 * What the signed-in person needs to act on a pull request in their own name: the repository as
 * its folder links it, and their own GitHub token. What they do goes to GitHub with that token,
 * and what GitHub answers is recorded straight away so everyone sees it without waiting for the
 * webhook. When the webhook does arrive it carries the same thing and changes nothing.
 */
async function pullAsPerson(
  env: ShuttleEnv,
  orgId: string,
  request: Request,
  input: { readonly folderId: string; readonly fullName: string; readonly number: number },
) {
  await ensureWorkspaceQuietly(env, orgId)
  await ensurePullsQuietly(env, orgId)

  const tree = await readWorkspaceFolders(env, orgId)
  const repo = tree.folders[input.folderId]?.repos.find((item) => item.fullName === input.fullName)

  if (!repo) {
    throw notFound('repository is not linked to this folder')
  }

  const userToken = await githubTokenOf(getAuth(env), request.headers)

  if (userToken === null || userToken === '') {
    // Clients tell this apart from other conflicts by the reason, which is the message.
    throw new ORPCError('CONFLICT', {
      message: GITHUB_NOT_CONNECTED,
      data: { message: 'Connect your GitHub account so this can be posted as you.' },
    })
  }

  return {
    repo,
    target: { repo, number: input.number, userToken },
    pullsStub: loomsStub(env.LOOMS_RUN, pullsRunId(env, orgId)),
  }
}

/** GitHub, or the way to it, refused something asked of it. */
function badGateway(cause: unknown, fallback: string): ORPCError<'BAD_GATEWAY', undefined> {
  return new ORPCError('BAD_GATEWAY', {
    message: cause instanceof Error ? cause.message : fallback,
  })
}

async function syncRepoPolicy(
  env: ShuttleEnv,
  orgId: string,
  fullName: string,
  installationId: number,
): Promise<void> {
  await ensurePullsQuietly(env, orgId)
  const tree = await readWorkspaceFolders(env, orgId)
  const folders: { folderId: string; autoReview: AutoReviewMode }[] = []

  for (const [folderId, folder] of Object.entries(tree.folders)) {
    if (folder.repos.some((repo) => repo.fullName === fullName)) {
      folders.push({
        folderId,
        autoReview: folder.autoReview ?? 'off',
      })
    }
  }

  const stub = loomsStub(env.LOOMS_RUN, pullsRunId(env, orgId))
  await stub.signal([setRepoPolicy({ fullName, installationId, folders })])
}

async function readWorkspaceFolders(
  env: ShuttleEnv,
  orgId: string,
): Promise<{
  folders: Record<
    string,
    {
      repos: readonly LinkedRepo[]
      autoReview?: AutoReviewMode
    }
  >
}> {
  const runId = workspaceRunId(env, orgId)
  const stub = loomsStub(env.LOOMS_RUN, runId)

  const response = await stub.fetch(
    new Request(`https://shuttle.internal/runs/${runId}/projections/workspaceTree`, {
      method: 'GET',
    }),
  )

  if (!response.ok) {
    return { folders: {} }
  }

  const body = FoldersProjection.parse(await response.json())

  return { folders: body.value?.folders ?? {} }
}

async function resolveRepo(
  env: ShuttleEnv,
  installationId: number,
  owner: string,
  name: string,
): Promise<LinkedRepo | null> {
  const installation = await getInstallation(env, installationId)

  if (!installation) {
    return null
  }

  const repos = await listInstallationRepos(env, installationId)

  const match = repos.find(
    (repo) =>
      repo.owner.toLowerCase() === owner.toLowerCase() &&
      repo.name.toLowerCase() === name.toLowerCase(),
  )

  return match ?? null
}

async function loadPlaybook(
  env: ShuttleEnv,
  orgId: string,
): Promise<{
  runId: string
  version: number
  lessons: { id: string; text: string; scope?: string }[]
}> {
  await ensurePlaybookQuietly(env, orgId)

  const runId = playbookRunId(env, orgId)
  const stub = loomsStub(env.LOOMS_RUN, runId)

  const request = new Request(`https://shuttle.internal/runs/${runId}/projections/activePlaybook`, {
    method: 'GET',
  })

  const response = await stub.fetch(request)

  if (!response.ok) {
    return { runId, version: 0, lessons: [] }
  }

  const body = PlaybookProjection.parse(await response.json())

  return {
    runId,
    version: body.value?.version ?? 0,
    lessons: body.value?.lessons ?? [],
  }
}

export const workspaceRouter = {
  /**
   * The two workspaces a person sees: the organization's, with its folders and public sessions,
   * and their own, with the sessions that are private to them or shared with them.
   */
  get: workspace.get.handler(async ({ context: { env, actor, ctx } }) => {
    const personalRunId = personalWorkspaceRunId(env, actor.orgId, actor.userId)

    const [shared, personal] = await Promise.all([
      ensureWorkspaceQuietly(env, actor.orgId).then(() =>
        readWorkspace(env, workspaceRunId(env, actor.orgId), ctx),
      ),
      ensureNamedWorkspace(env, personalRunId).then(() => readWorkspace(env, personalRunId, ctx)),
    ])

    return { ...shared, personal }
  }),

  createSession: workspace.createSession.handler(async ({ input, context: { env, actor } }) => {
    const { orgId } = actor
    const { folderId, goal } = input

    // One of the caller's own machines to start on, as the desktop app asks for.
    const deviceId = input.deviceId ?? null

    if (deviceId !== null && !DEVICE_ID.test(deviceId)) {
      throw badRequest('Invalid device id')
    }

    // A new session is private, so it is listed in its owner's workspace and nowhere else.
    const personalRunId = personalWorkspaceRunId(env, orgId, actor.userId)

    const [, , playbook, tree] = await Promise.all([
      ensureWorkspaceQuietly(env, orgId),
      ensureNamedWorkspace(env, personalRunId),
      loadPlaybook(env, orgId),
      readWorkspaceFolders(env, orgId),
    ])

    const runId = scopedRunId(orgId, `session_${crypto.randomUUID()}`)
    const stub = loomsStub(env.LOOMS_RUN, personalRunId)

    // Recorded before the session exists, so there is no moment when it is open to everyone.
    await loomsStub(env.LOOMS_RUN, runId).setAccess(privateTo(actor))

    // Also before it exists, so its first turn already runs where it was asked to.
    if (deviceId !== null && deviceId !== '') {
      await loomsStub(env.LOOMS_RUN, runId).placeSandbox({
        kind: 'local',
        userId: actor.userId,
        deviceId,
      })
    }

    const files = input.files ?? []

    const bucket = env.ASSETS

    if (files.length > 0 && bucket === undefined) {
      throw new ORPCError('SERVICE_UNAVAILABLE', { message: 'File storage is not set up.' })
    }

    const stored: AssetRef[] = []

    try {
      // Uploaded together; each File is already in memory, so R2 reads it without another copy.
      const attachments =
        bucket === undefined
          ? []
          : await Promise.all(
              files.map(async (file) => {
                const asset = await putAsset(bucket, runId, {
                  name: file.name,
                  mediaType: uploadMediaType(file.type, file.name),
                  body: file,
                  source: 'upload',
                  createdBy: actor.userId,
                })

                stored.push(asset)
                return asset
              }),
            )

      await stub.signal([
        requestSession({
          runId,
          folderId,
          goal,
          attachments: attachments.length > 0 ? attachments : undefined,
          lessons: playbook.lessons,
          playbookVersion: playbook.version,
          playbookRunId: playbook.runId,
          ownerId: actor.userId,
          // The folder lives in the organization's workspace, which this one cannot read.
          repos: tree.folders[folderId]?.repos ?? [],
        }),
      ])
    } catch (cause) {
      // No session exists to reach these files through, so none may be left behind.
      if (bucket !== undefined) {
        await Promise.allSettled(stored.map((asset) => deleteAsset(bucket, runId, asset.id)))
      }

      throw cause
    }

    return { runId }
  }),

  repos: {
    link: workspace.repos.link.handler(async ({ input, context: { env, actor } }) => {
      const { orgId } = actor
      const { folderId, installationId } = input

      await ensureWorkspaceQuietly(env, orgId)

      // The App can read every installation. Only one this organization connected may be used.
      if (!env.AUTH_DB || !(await installationConnected(env.AUTH_DB, installationId, orgId))) {
        throw notFound('Repository not found on that installation')
      }

      const repo = await resolveRepo(env, installationId, input.owner, input.name)

      if (!repo) {
        throw notFound('Repository not found on that installation')
      }

      const stub = loomsStub(env.LOOMS_RUN, workspaceRunId(env, orgId))
      await stub.signal([linkRepo({ folderId, repo })])
      await syncRepoPolicy(env, orgId, repo.fullName, repo.installationId)
      await syncPullsOfFolder(env, orgId, folderId)

      return { folderId, repo }
    }),

    unlink: workspace.repos.unlink.handler(async ({ input, context: { env, actor } }) => {
      const { orgId } = actor
      const { folderId, fullName } = input

      await ensureWorkspaceQuietly(env, orgId)

      const tree = await readWorkspaceFolders(env, orgId)
      const folder = tree.folders[folderId]
      const repo = folder?.repos.find((item) => item.fullName === fullName)

      const stub = loomsStub(env.LOOMS_RUN, workspaceRunId(env, orgId))
      await stub.signal([unlinkRepo({ folderId, fullName })])

      if (repo) {
        await syncRepoPolicy(env, orgId, fullName, repo.installationId)
      }

      return { folderId, fullName, unlinked: true as const }
    }),
  },

  pulls: {
    sync: workspace.pulls.sync.handler(async ({ input, context: { env, actor } }) => {
      const report = await syncPullsOfFolder(env, actor.orgId, input.folderId)

      if (!report) {
        throw notFound('folder not found')
      }

      return report
    }),

    /** Fetches a pull request's review threads from GitHub into the mirror people read. */
    syncThreads: workspace.pulls.syncThreads.handler(async ({ input, context: { env, actor } }) => {
      const { orgId } = actor

      await ensureWorkspaceQuietly(env, orgId)
      await ensurePullsQuietly(env, orgId)

      const tree = await readWorkspaceFolders(env, orgId)

      const repo = tree.folders[input.folderId]?.repos.find(
        (item) => item.fullName === input.fullName,
      )

      if (!repo) {
        throw notFound('repository is not linked to this folder')
      }

      try {
        return await syncPullThreads(env, orgId, repo, input.number)
      } catch (cause) {
        throw badGateway(cause, 'could not read review threads')
      }
    }),

    /** A reply to a thread, or a comment on a line that starts one, in the person's own name. */
    comment: workspace.pulls.comment.handler(
      async ({ input, context: { env, actor, request } }) => {
        const { fullName, number } = input
        const { repo, target, pullsStub } = await pullAsPerson(env, actor.orgId, request, input)
        const text = input.body.trim()

        if (text === '') {
          throw badRequest('a comment needs something in it')
        }

        if (input.rootId === undefined && (input.path === undefined || input.line === undefined)) {
          throw badRequest('a comment needs a thread or a line')
        }

        try {
          let comment

          if (input.rootId !== undefined) {
            comment = await replyToThread(env, { ...target, rootId: input.rootId, body: text })
          } else {
            const { path = '', line = 0, startLine } = input
            const pull = await getPullRequest(env, repo, number)

            comment = await commentOnLine(env, {
              ...target,
              commitId: pull.headSha,
              path,
              line,
              side: input.side ?? 'RIGHT',
              start:
                startLine !== undefined && startLine !== line
                  ? { line: startLine, side: input.startSide ?? 'RIGHT' }
                  : undefined,
              body: text,
            })
          }

          await pullsStub.signal([upsertComment({ fullName, number, comment })])

          return { ok: true as const, commentId: comment.commentId }
        } catch (cause) {
          throw badGateway(cause, 'GitHub did not accept that')
        }
      },
    ),

    resolveThread: workspace.pulls.resolveThread.handler(
      async ({ input, context: { env, actor, request } }) => {
        const { fullName, number, rootId, resolved } = input
        const { target, pullsStub } = await pullAsPerson(env, actor.orgId, request, input)

        try {
          await setThreadResolved({ ...target, rootId, resolved })

          await pullsStub.signal([
            setThreadResolution({ fullName, number, rootId, resolved, updatedAt: Date.now() }),
          ])

          return { ok: true as const }
        } catch (cause) {
          throw badGateway(cause, 'GitHub did not accept that')
        }
      },
    ),

    review: workspace.pulls.review.handler(async ({ input, context: { env, actor } }) => {
      const { orgId } = actor
      const { folderId, fullName, number } = input
      const personalRunId = personalWorkspaceRunId(env, orgId, actor.userId)

      const [, , tree] = await Promise.all([
        ensureWorkspaceQuietly(env, orgId),
        ensureNamedWorkspace(env, personalRunId),
        readWorkspaceFolders(env, orgId),
      ])

      const runId = scopedRunId(orgId, crypto.randomUUID())
      const stub = loomsStub(env.LOOMS_RUN, personalRunId)

      await loomsStub(env.LOOMS_RUN, runId).setAccess(privateTo(actor))

      await stub.signal([
        requestSession({
          runId,
          folderId,
          goal: input.title ?? `Review ${fullName}#${number}`,
          lessons: [],
          playbookVersion: 0,
          playbookRunId: null,
          definitionName: 'review',
          ownerId: actor.userId,
          repos: tree.folders[folderId]?.repos ?? [],
          pull: {
            fullName,
            number,
            headSha: input.headSha,
            baseSha: input.baseSha ?? '',
          },
        }),
      ])

      // Linked now, not when a review is submitted, so the pull request shows its reviewer.
      // The session is already running, so a failure here must not fail the request.
      try {
        await ensurePullsQuietly(env, orgId)

        await loomsStub(env.LOOMS_RUN, pullsRunId(env, orgId)).signal([
          linkReviewSession({ fullName, number, runId }),
        ])
      } catch (cause) {
        console.error(`Could not link review session ${runId} to ${fullName}#${number}`, cause)
      }

      return { runId }
    }),
  },
}

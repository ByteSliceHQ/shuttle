import { DEVICE_ID } from '@shuttle/runner-protocol'

import {
  MAX_ASSET_BYTES,
  MAX_ATTACHMENTS,
  putAsset,
  cleanMediaType,
  type AssetRef,
} from '../assets/store'
import { getAuth } from '../auth/auth'
import {
  ensureNamedWorkspace,
  ensurePlaybookQuietly,
  ensurePullsQuietly,
  ensureWorkspaceQuietly,
} from '../bootstrap'
import { personalWorkspaceRunId, playbookRunId, pullsRunId, workspaceRunId } from '../config'
import type { ShuttleEnv } from '../env'
import { getInstallation, listInstallationRepos } from '../github/app'
import { commentOnLine, getPullRequest, replyToThread, setThreadResolved } from '../github/pulls'
import { GITHUB_NOT_CONNECTED, githubTokenOf } from '../github/user-token'
import { loomsStub } from '../looms-stub'
import { syncFolderRepos } from '../pulls/folder-sync'
import type { AutoReviewMode } from '../pulls/scope'
import {
  linkReviewSession,
  setRepoPolicy,
  setThreadResolution,
  upsertComment,
} from '../pulls/signals'
import { syncPullThreads } from '../pulls/thread-sync'
import type { Actor, SessionAccess } from '../tenancy/access'
import { installationConnected } from '../tenancy/installations'
import { scopedRunId } from '../tenancy/run-id'
import {
  linkRepo,
  reportActivity,
  requestSession,
  unlinkRepo,
  type LinkedRepo,
} from '../workspace/module'
import { readCapped } from './assets'

export async function handleWorkspaceRoutes(
  request: Request,
  env: ShuttleEnv,
  actor: Actor,
  ctx?: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url)
  const { orgId } = actor

  if (request.method === 'GET' && url.pathname === '/workspace') {
    return getWorkspace(env, actor, ctx)
  }

  if (request.method === 'POST' && url.pathname === '/workspace/sessions') {
    return createWorkspaceSession(request, env, actor)
  }

  const linkMatch = url.pathname.match(/^\/workspace\/folders\/([^/]+)\/repos$/)

  if (linkMatch) {
    const folderId = decodeURIComponent(linkMatch[1] ?? '')

    if (request.method === 'POST') {
      return linkFolderRepo(request, env, orgId, folderId)
    }

    if (request.method === 'DELETE') {
      return unlinkFolderRepo(request, env, orgId, folderId)
    }
  }

  const syncMatch = url.pathname.match(/^\/workspace\/folders\/([^/]+)\/pulls\/sync$/)

  if (syncMatch && request.method === 'POST') {
    return syncFolderPulls(env, orgId, decodeURIComponent(syncMatch[1] ?? ''))
  }

  const threadsMatch = url.pathname.match(
    /^\/workspace\/folders\/([^/]+)\/pulls\/([^/]+)\/(\d+)\/threads\/sync$/,
  )

  if (threadsMatch && request.method === 'POST') {
    return syncThreadsOfPull(
      env,
      orgId,
      decodeURIComponent(threadsMatch[1] ?? ''),
      decodeURIComponent(threadsMatch[2] ?? ''),
      Number(threadsMatch[3]),
    )
  }

  const commentsMatch = url.pathname.match(
    /^\/workspace\/folders\/([^/]+)\/pulls\/([^/]+)\/(\d+)\/comments$/,
  )

  if (commentsMatch && request.method === 'POST') {
    return actOnPullAsPerson(
      request,
      env,
      orgId,
      decodeURIComponent(commentsMatch[1] ?? ''),
      decodeURIComponent(commentsMatch[2] ?? ''),
      Number(commentsMatch[3]),
      null,
    )
  }

  const resolutionMatch = url.pathname.match(
    /^\/workspace\/folders\/([^/]+)\/pulls\/([^/]+)\/(\d+)\/threads\/(\d+)\/resolution$/,
  )

  if (resolutionMatch && request.method === 'POST') {
    return actOnPullAsPerson(
      request,
      env,
      orgId,
      decodeURIComponent(resolutionMatch[1] ?? ''),
      decodeURIComponent(resolutionMatch[2] ?? ''),
      Number(resolutionMatch[3]),
      Number(resolutionMatch[4]),
    )
  }

  const reviewMatch = url.pathname.match(
    /^\/workspace\/folders\/([^/]+)\/pulls\/([^/]+)\/(\d+)\/review$/,
  )

  if (reviewMatch && request.method === 'POST') {
    return startPullReview(
      request,
      env,
      actor,
      decodeURIComponent(reviewMatch[1] ?? ''),
      decodeURIComponent(reviewMatch[2] ?? ''),
      Number(reviewMatch[3]),
    )
  }

  return null
}

/**
 * The two workspaces a person sees: the organization's, with its folders and public sessions,
 * and their own, with the sessions that are private to them or shared with them.
 */
async function getWorkspace(
  env: ShuttleEnv,
  actor: Actor,
  ctx?: ExecutionContext,
): Promise<Response> {
  const personalRunId = personalWorkspaceRunId(env, actor.orgId, actor.userId)

  const [shared, personal] = await Promise.all([
    ensureWorkspaceQuietly(env, actor.orgId).then(() =>
      readWorkspace(env, workspaceRunId(env, actor.orgId), ctx),
    ),
    ensureNamedWorkspace(env, personalRunId).then(() => readWorkspace(env, personalRunId, ctx)),
  ])

  return Response.json({ ...shared, personal })
}

async function readWorkspace(env: ShuttleEnv, runId: string, ctx?: ExecutionContext) {
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

  const treeBody = treeResponse.ok ? ((await treeResponse.json()) as { value?: unknown }) : null
  const tabsBody = tabsResponse.ok ? ((await tabsResponse.json()) as { value?: unknown }) : null

  ctx?.waitUntil(reconcileActiveWorkspaceSessions(env, runId, treeBody?.value))

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
  initialTree?: unknown,
): Promise<void> {
  try {
    const stub = loomsStub(env.LOOMS_RUN, workspaceId)
    let treeValue = initialTree

    if (!treeValue) {
      const response = await stub.fetch(
        new Request(`https://shuttle.internal/runs/${workspaceId}/projections/workspaceTree`, {
          method: 'GET',
        }),
      )

      if (!response.ok) {
        return
      }

      const body = (await response.json()) as { value?: unknown }
      treeValue = body.value
    }

    const body = { value: treeValue } as {
      value?: {
        sessions?: Record<
          string,
          {
            runId?: unknown
            status?: unknown
            activity?: unknown
            activitySeq?: unknown
            updatedAt?: unknown
          }
        >
      }
    }

    const activeSessions = Object.values(body.value?.sessions ?? {}).flatMap((session) =>
      typeof session.runId === 'string' &&
      session.status === 'running' &&
      session.activity === 'working'
        ? [
            {
              runId: session.runId,
              activitySeq:
                typeof session.activitySeq === 'number' ? session.activitySeq : undefined,
              updatedAt: typeof session.updatedAt === 'number' ? session.updatedAt : 0,
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

async function createWorkspaceSession(
  request: Request,
  env: ShuttleEnv,
  actor: Actor,
): Promise<Response> {
  const { orgId } = actor

  const multipart = request.headers.get('content-type')?.startsWith('multipart/form-data')
  let files: File[] = []
  let data: unknown

  if (multipart) {
    if (!env.ASSETS) {
      return Response.json({ error: 'File storage is not set up.' }, { status: 503 })
    }

    if (!request.body) {
      return Response.json({ error: 'Missing request body' }, { status: 400 })
    }

    const bytes = await readCapped(request.body, MAX_ASSET_BYTES)

    if (!bytes) {
      return Response.json({ error: 'Attachments exceed 50 MB.' }, { status: 413 })
    }

    const form = await new Response(bytes, {
      headers: { 'content-type': request.headers.get('content-type')! },
    })
      .formData()
      .catch(() => null)

    if (!form) {
      return Response.json({ error: 'Invalid form data' }, { status: 400 })
    }

    const entries = form.getAll('files')

    if (
      entries.length > MAX_ATTACHMENTS ||
      entries.some((file) => typeof file === 'string' || file.size === 0)
    ) {
      return Response.json({ error: 'Attach up to 10 nonempty files.' }, { status: 400 })
    }

    files = entries.filter((file): file is File => typeof file !== 'string')

    data = {
      folderId: form.get('folderId'),
      goal: form.get('goal'),
      deviceId: form.get('deviceId'),
    }
  } else {
    data = await request.json().catch(() => null)
  }

  const body = data as {
    folderId?: unknown
    goal?: unknown
    deviceId?: unknown
  } | null

  const folderId = typeof body?.folderId === 'string' ? body.folderId : null
  const goal = typeof body?.goal === 'string' ? body.goal.trim() : ''

  if (!folderId || !goal) {
    return Response.json({ error: 'folderId and goal are required' }, { status: 400 })
  }

  // One of the caller's own machines to start on, as the desktop app asks for.
  const deviceId = typeof body?.deviceId === 'string' ? body.deviceId : null

  if (deviceId !== null && !DEVICE_ID.test(deviceId)) {
    return Response.json({ error: 'Invalid device id' }, { status: 400 })
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
  if (deviceId) {
    await loomsStub(env.LOOMS_RUN, runId).placeSandbox({
      kind: 'local',
      userId: actor.userId,
      deviceId,
    })
  }

  const attachments: AssetRef[] = []

  for (const file of files) {
    attachments.push(
      await putAsset(env.ASSETS!, runId, {
        name: file.name,
        mediaType: cleanMediaType(file.type) ?? 'application/octet-stream',
        body: await file.arrayBuffer(),
        source: 'upload',
        createdBy: actor.userId,
      }),
    )
  }

  await stub.signal([
    requestSession({
      runId,
      folderId,
      goal,
      ...(attachments.length ? { attachments } : {}),
      lessons: playbook.lessons,
      playbookVersion: playbook.version,
      playbookRunId: playbook.runId,
      ownerId: actor.userId,
      // The folder lives in the organization's workspace, which this one cannot read.
      repos: tree.folders[folderId]?.repos ?? [],
    }),
  ])

  return Response.json({ runId })
}

function privateTo(actor: Actor): SessionAccess {
  return { ownerId: actor.userId, memberIds: [], visibility: 'private' }
}

async function linkFolderRepo(
  request: Request,
  env: ShuttleEnv,
  orgId: string,
  folderId: string,
): Promise<Response> {
  await ensureWorkspaceQuietly(env, orgId)

  const body = (await request.json().catch(() => null)) as {
    installationId?: unknown
    owner?: unknown
    name?: unknown
  } | null

  const installationId =
    typeof body?.installationId === 'number' ? body.installationId : Number(body?.installationId)

  const owner = typeof body?.owner === 'string' ? body.owner : null
  const name = typeof body?.name === 'string' ? body.name : null

  if (!Number.isFinite(installationId) || !owner || !name) {
    return Response.json({ error: 'installationId, owner, and name are required' }, { status: 400 })
  }

  // The App can read every installation. Only one this organization connected may be used.
  if (!env.AUTH_DB || !(await installationConnected(env.AUTH_DB, installationId, orgId))) {
    return Response.json({ error: 'Repository not found on that installation' }, { status: 404 })
  }

  const repo = await resolveRepo(env, installationId, owner, name)

  if (!repo) {
    return Response.json({ error: 'Repository not found on that installation' }, { status: 404 })
  }

  const stub = loomsStub(env.LOOMS_RUN, workspaceRunId(env, orgId))
  await stub.signal([linkRepo({ folderId, repo })])
  await syncRepoPolicy(env, orgId, repo.fullName, repo.installationId)
  await syncFolderPulls(env, orgId, folderId)

  return Response.json({ folderId, repo })
}

async function unlinkFolderRepo(
  request: Request,
  env: ShuttleEnv,
  orgId: string,
  folderId: string,
): Promise<Response> {
  await ensureWorkspaceQuietly(env, orgId)

  const body = (await request.json().catch(() => null)) as { fullName?: unknown } | null
  const fullName = typeof body?.fullName === 'string' ? body.fullName : null

  if (!fullName) {
    return Response.json({ error: 'fullName is required' }, { status: 400 })
  }

  const tree = await readWorkspaceFolders(env, orgId)
  const folder = tree.folders[folderId]
  const repo = folder?.repos.find((item) => item.fullName === fullName)

  const stub = loomsStub(env.LOOMS_RUN, workspaceRunId(env, orgId))
  await stub.signal([unlinkRepo({ folderId, fullName })])

  if (repo) {
    await syncRepoPolicy(env, orgId, fullName, repo.installationId)
  }

  return Response.json({ folderId, fullName, unlinked: true })
}

async function syncFolderPulls(
  env: ShuttleEnv,
  orgId: string,
  folderId: string,
): Promise<Response> {
  await ensureWorkspaceQuietly(env, orgId)
  await ensurePullsQuietly(env, orgId)

  const tree = await readWorkspaceFolders(env, orgId)
  const folder = tree.folders[folderId]

  if (!folder) {
    return Response.json({ error: 'folder not found' }, { status: 404 })
  }

  const pullsStub = loomsStub(env.LOOMS_RUN, pullsRunId(env, orgId))
  return Response.json(await syncFolderRepos(env, pullsStub, folderId, folder.repos))
}

/** Fetches a pull request's review threads from GitHub into the mirror people read. */
async function syncThreadsOfPull(
  env: ShuttleEnv,
  orgId: string,
  folderId: string,
  fullName: string,
  number: number,
): Promise<Response> {
  await ensureWorkspaceQuietly(env, orgId)
  await ensurePullsQuietly(env, orgId)

  const tree = await readWorkspaceFolders(env, orgId)
  const repo = tree.folders[folderId]?.repos.find((item) => item.fullName === fullName)

  if (!repo) {
    return Response.json({ error: 'repository is not linked to this folder' }, { status: 404 })
  }

  try {
    return Response.json(await syncPullThreads(env, orgId, repo, number))
  } catch (cause) {
    return Response.json(
      { error: cause instanceof Error ? cause.message : 'could not read review threads' },
      { status: 502 },
    )
  }
}

/**
 * Something the signed-in person does on a pull request in their own name: a reply, a comment on
 * a line, or resolving a thread (when `resolutionOf` names one). It goes to GitHub with their own
 * token, and what GitHub answers is recorded straight away so everyone sees it without waiting
 * for the webhook. When the webhook does arrive it carries the same comment and changes nothing.
 */
async function actOnPullAsPerson(
  request: Request,
  env: ShuttleEnv,
  orgId: string,
  folderId: string,
  fullName: string,
  number: number,
  resolutionOf: number | null,
): Promise<Response> {
  await ensureWorkspaceQuietly(env, orgId)
  await ensurePullsQuietly(env, orgId)

  const tree = await readWorkspaceFolders(env, orgId)
  const repo = tree.folders[folderId]?.repos.find((item) => item.fullName === fullName)

  if (!repo) {
    return Response.json({ error: 'repository is not linked to this folder' }, { status: 404 })
  }

  const userToken = await githubTokenOf(getAuth(env), request.headers)

  if (!userToken) {
    return Response.json(
      {
        error: GITHUB_NOT_CONNECTED,
        message: 'Connect your GitHub account so this can be posted as you.',
      },
      { status: 409 },
    )
  }

  const body = (await request.json().catch(() => ({}))) as {
    body?: unknown
    rootId?: unknown
    path?: unknown
    line?: unknown
    side?: unknown
    startLine?: unknown
    startSide?: unknown
    resolved?: unknown
  }

  const pullsStub = loomsStub(env.LOOMS_RUN, pullsRunId(env, orgId))
  const target = { repo, number, userToken }

  try {
    if (resolutionOf !== null) {
      const resolved = body.resolved === true

      await setThreadResolved({ ...target, rootId: resolutionOf, resolved })

      await pullsStub.signal([
        setThreadResolution({
          fullName,
          number,
          rootId: resolutionOf,
          resolved,
          updatedAt: Date.now(),
        }),
      ])

      return Response.json({ ok: true })
    }

    const text = typeof body.body === 'string' ? body.body.trim() : ''

    if (!text) {
      return Response.json({ error: 'a comment needs something in it' }, { status: 400 })
    }

    let comment

    if (typeof body.rootId === 'number') {
      comment = await replyToThread(env, { ...target, rootId: body.rootId, body: text })
    } else if (typeof body.path === 'string' && typeof body.line === 'number') {
      const pull = await getPullRequest(env, repo, number)

      comment = await commentOnLine(env, {
        ...target,
        commitId: pull.headSha,
        path: body.path,
        line: body.line,
        side: body.side === 'LEFT' ? 'LEFT' : 'RIGHT',
        ...(typeof body.startLine === 'number' && body.startLine !== body.line
          ? {
              start: {
                line: body.startLine,
                side: body.startSide === 'LEFT' ? ('LEFT' as const) : ('RIGHT' as const),
              },
            }
          : {}),
        body: text,
      })
    } else {
      return Response.json({ error: 'a comment needs a thread or a line' }, { status: 400 })
    }

    await pullsStub.signal([upsertComment({ fullName, number, comment })])

    return Response.json({ ok: true, commentId: comment.commentId })
  } catch (cause) {
    return Response.json(
      { error: cause instanceof Error ? cause.message : 'GitHub did not accept that' },
      { status: 502 },
    )
  }
}

async function startPullReview(
  request: Request,
  env: ShuttleEnv,
  actor: Actor,
  folderId: string,
  fullName: string,
  number: number,
): Promise<Response> {
  const { orgId } = actor
  const personalRunId = personalWorkspaceRunId(env, orgId, actor.userId)

  const [, , tree] = await Promise.all([
    ensureWorkspaceQuietly(env, orgId),
    ensureNamedWorkspace(env, personalRunId),
    readWorkspaceFolders(env, orgId),
  ])

  const body = (await request.json().catch(() => ({}))) as {
    headSha?: string
    baseSha?: string
    title?: string
  }

  // The session checks this commit out to read; without it there is nothing to review.
  if (!body.headSha) {
    return Response.json({ error: 'headSha is required' }, { status: 400 })
  }

  const runId = scopedRunId(orgId, crypto.randomUUID())
  const stub = loomsStub(env.LOOMS_RUN, personalRunId)

  await loomsStub(env.LOOMS_RUN, runId).setAccess(privateTo(actor))

  await stub.signal([
    requestSession({
      runId,
      folderId,
      goal: body.title ?? `Review ${fullName}#${number}`,
      lessons: [],
      playbookVersion: 0,
      playbookRunId: null,
      definitionName: 'review',
      ownerId: actor.userId,
      repos: tree.folders[folderId]?.repos ?? [],
      pull: {
        fullName,
        number,
        headSha: body.headSha,
        baseSha: body.baseSha ?? '',
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

  return Response.json({ runId })
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
      repos: LinkedRepo[]
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

  const body = (await response.json()) as {
    value?: {
      folders?: Record<
        string,
        {
          repos?: LinkedRepo[]
          autoReview?: AutoReviewMode
        }
      >
    }
  }

  const folders: Record<string, { repos: LinkedRepo[]; autoReview?: AutoReviewMode }> = {}

  for (const [folderId, folder] of Object.entries(body.value?.folders ?? {})) {
    folders[folderId] = {
      repos: folder.repos ?? [],
      autoReview: folder.autoReview,
    }
  }

  return { folders }
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

  const body = (await response.json()) as {
    value?: {
      version?: number
      lessons?: { id: string; text: string; scope?: string }[]
    }
  }

  return {
    runId,
    version: body.value?.version ?? 0,
    lessons: body.value?.lessons ?? [],
  }
}

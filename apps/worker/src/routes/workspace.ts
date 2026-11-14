import {
  ensureNamedWorkspace,
  ensurePlaybookQuietly,
  ensurePullsQuietly,
  ensureWorkspaceQuietly,
} from '../bootstrap'
import { personalWorkspaceRunId, playbookRunId, pullsRunId, workspaceRunId } from '../config'
import type { ShuttleEnv } from '../env'
import { getInstallation, listInstallationRepos } from '../github/app'
import { loomsStub } from '../looms-stub'
import { syncFolderRepos } from '../pulls/folder-sync'
import type { AutoReviewMode } from '../pulls/scope'
import { setRepoPolicy } from '../pulls/signals'
import type { Actor, SessionAccess } from '../tenancy/access'
import { orgOfInstallation } from '../tenancy/installations'
import { scopedRunId } from '../tenancy/run-id'
import {
  linkRepo,
  reportActivity,
  requestSession,
  unlinkRepo,
  type LinkedRepo,
} from '../workspace/module'

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

  const body = (await request.json().catch(() => null)) as {
    folderId?: unknown
    goal?: unknown
  } | null

  const folderId = typeof body?.folderId === 'string' ? body.folderId : null
  const goal = typeof body?.goal === 'string' ? body.goal.trim() : ''

  if (!folderId || !goal) {
    return Response.json({ error: 'folderId and goal are required' }, { status: 400 })
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

  await stub.signal([
    requestSession({
      runId,
      folderId,
      goal,
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

  // The App can read every installation. Only one connected to this organization may be used.
  if (!env.AUTH_DB || (await orgOfInstallation(env.AUTH_DB, installationId)) !== orgId) {
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
        headSha: body.headSha ?? '',
        baseSha: body.baseSha ?? '',
      },
    }),
  ])

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

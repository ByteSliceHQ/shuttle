import { ensurePlaybookQuietly, ensureWorkspaceQuietly } from '../bootstrap'
import { playbookRunId, workspaceRunId } from '../config'
import type { ShuttleEnv } from '../env'
import { getInstallation, listInstallationRepos } from '../github/app'
import { loomsStub } from '../looms-stub'
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
  ctx?: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url)

  if (request.method === 'GET' && url.pathname === '/workspace') {
    return getWorkspace(env, ctx)
  }

  if (request.method === 'POST' && url.pathname === '/workspace/sessions') {
    return createWorkspaceSession(request, env)
  }

  const linkMatch = url.pathname.match(/^\/workspace\/folders\/([^/]+)\/repos$/)

  if (linkMatch) {
    const folderId = decodeURIComponent(linkMatch[1] ?? '')

    if (request.method === 'POST') {
      return linkFolderRepo(request, env, folderId)
    }

    if (request.method === 'DELETE') {
      return unlinkFolderRepo(request, env, folderId)
    }
  }

  return null
}

async function getWorkspace(env: ShuttleEnv, ctx?: ExecutionContext): Promise<Response> {
  await ensureWorkspaceQuietly(env)
  const runId = workspaceRunId(env)
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

  return Response.json({
    runId,
    tail,
    tree: treeBody?.value ?? null,
    tabs: tabsBody?.value ?? null,
  })
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

async function createWorkspaceSession(request: Request, env: ShuttleEnv): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    folderId?: unknown
    goal?: unknown
  } | null

  const folderId = typeof body?.folderId === 'string' ? body.folderId : null
  const goal = typeof body?.goal === 'string' ? body.goal.trim() : ''

  if (!folderId || !goal) {
    return Response.json({ error: 'folderId and goal are required' }, { status: 400 })
  }

  const [, playbook] = await Promise.all([ensureWorkspaceQuietly(env), loadPlaybook(env)])
  const runId = `session_${crypto.randomUUID()}`
  const stub = loomsStub(env.LOOMS_RUN, workspaceRunId(env))

  await stub.signal([
    requestSession({
      runId,
      folderId,
      goal,
      lessons: playbook.lessons,
      playbookVersion: playbook.version,
      playbookRunId: playbook.runId,
    }),
  ])

  return Response.json({ runId })
}

async function linkFolderRepo(
  request: Request,
  env: ShuttleEnv,
  folderId: string,
): Promise<Response> {
  await ensureWorkspaceQuietly(env)

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

  const repo = await resolveRepo(env, installationId, owner, name)

  if (!repo) {
    return Response.json({ error: 'Repository not found on that installation' }, { status: 404 })
  }

  const stub = loomsStub(env.LOOMS_RUN, workspaceRunId(env))
  await stub.signal([linkRepo({ folderId, repo })])

  return Response.json({ folderId, repo })
}

async function unlinkFolderRepo(
  request: Request,
  env: ShuttleEnv,
  folderId: string,
): Promise<Response> {
  await ensureWorkspaceQuietly(env)

  const body = (await request.json().catch(() => null)) as { fullName?: unknown } | null
  const fullName = typeof body?.fullName === 'string' ? body.fullName : null

  if (!fullName) {
    return Response.json({ error: 'fullName is required' }, { status: 400 })
  }

  const stub = loomsStub(env.LOOMS_RUN, workspaceRunId(env))
  await stub.signal([unlinkRepo({ folderId, fullName })])

  return Response.json({ folderId, fullName, unlinked: true })
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

async function loadPlaybook(env: ShuttleEnv): Promise<{
  runId: string
  version: number
  lessons: { id: string; text: string; scope?: string }[]
}> {
  await ensurePlaybookQuietly(env)

  const runId = playbookRunId(env)
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

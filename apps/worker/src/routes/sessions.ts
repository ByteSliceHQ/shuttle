import { playbookRunId, workspaceRunId } from '../config'
import type { ShuttleEnv } from '../env'
import { isVendorHarness, parseHarness } from '../harness'
import { loomsStub } from '../looms-stub'
import { parseTeam } from '../team'
import { vendorHarnessInfo } from '../vendor/harnesses'
import { parseVendorModelChoice } from '../vendor/models'

export async function handleShuttleRoutes(
  request: Request,
  env: ShuttleEnv,
): Promise<Response | null> {
  const url = new URL(request.url)

  if (request.method === 'GET' && url.pathname === '/sessions') {
    return listSessions(env)
  }

  const treeMatch = url.pathname.match(/^\/sessions\/([^/]+)\/tree$/)

  if (request.method === 'GET' && treeMatch) {
    return sessionTree(env, decodeURIComponent(treeMatch[1] ?? ''))
  }

  const modelMatch = url.pathname.match(/^\/sessions\/([^/]+)\/llm-model$/)

  if (modelMatch) {
    return sessionLlmModel(request, env, decodeURIComponent(modelMatch[1] ?? ''))
  }

  const harnessMatch = url.pathname.match(/^\/sessions\/([^/]+)\/harness$/)

  if (harnessMatch) {
    return sessionHarness(request, env, decodeURIComponent(harnessMatch[1] ?? ''))
  }

  const teamMatch = url.pathname.match(/^\/sessions\/([^/]+)\/team$/)

  if (teamMatch) {
    return sessionTeam(request, env, decodeURIComponent(teamMatch[1] ?? ''))
  }

  const vendorModelsMatch = url.pathname.match(/^\/sessions\/([^/]+)\/vendor-models$/)

  if (vendorModelsMatch) {
    return sessionVendorModels(request, env, decodeURIComponent(vendorModelsMatch[1] ?? ''))
  }

  const stopMatch = url.pathname.match(/^\/sessions\/([^/]+)\/stop$/)

  if (request.method === 'POST' && stopMatch) {
    return sessionStop(request, env, decodeURIComponent(stopMatch[1] ?? ''))
  }

  if (request.method === 'GET' && url.pathname === '/playbook') {
    return getPlaybook(env)
  }

  if (request.method === 'POST' && url.pathname === '/playbook/ensure') {
    return ensurePlaybook(env)
  }

  return null
}

async function sessionStop(request: Request, env: ShuttleEnv, runId: string): Promise<Response> {
  if (!runId) {
    return Response.json({ error: 'Invalid session id' }, { status: 400 })
  }

  const body = (await request.json().catch(() => null)) as { threadId?: unknown } | null
  const fromQuery = new URL(request.url).searchParams.get('threadId')

  const threadId =
    (typeof fromQuery === 'string' && fromQuery.trim().length > 0 ? fromQuery.trim() : null) ??
    (typeof body?.threadId === 'string' && body.threadId.trim().length > 0
      ? body.threadId.trim()
      : null)

  if (!threadId) {
    return Response.json({ error: 'threadId is required' }, { status: 400 })
  }

  const stub = loomsStub(env.LOOMS_RUN, runId)
  const idempotencyKey = `ui-stop:${threadId}:${Date.now()}`

  await stub.signal([
    {
      type: 'agent.turn.stopped',
      threadId,
      payload: {},
      idempotencyKey,
    },
  ])

  return Response.json({ ok: true, threadId })
}

async function sessionLlmModel(
  request: Request,
  env: ShuttleEnv,
  runId: string,
): Promise<Response> {
  if (!runId) {
    return Response.json({ error: 'Invalid session id' }, { status: 400 })
  }

  const stub = loomsStub(env.LOOMS_RUN, runId)

  if (request.method === 'GET') {
    return Response.json(await stub.getLlmModel())
  }

  if (request.method === 'PUT' || request.method === 'POST') {
    const body = (await request.json().catch(() => null)) as { model?: unknown } | null
    const model = typeof body?.model === 'string' ? body.model.trim() : ''

    if (!model) {
      return Response.json({ error: 'model is required' }, { status: 400 })
    }

    return Response.json(await stub.setLlmModel(model))
  }

  return Response.json({ error: 'Method not allowed' }, { status: 405 })
}

async function sessionHarness(request: Request, env: ShuttleEnv, runId: string): Promise<Response> {
  if (!runId) {
    return Response.json({ error: 'Invalid session id' }, { status: 400 })
  }

  const stub = loomsStub(env.LOOMS_RUN, runId)

  if (request.method === 'GET') {
    return Response.json(await stub.getHarness())
  }

  if (request.method === 'PUT' || request.method === 'POST') {
    const body = (await request.json().catch(() => null)) as { harness?: unknown } | null
    const harness = parseHarness(body?.harness)

    if (!harness) {
      return Response.json({ error: 'unknown harness' }, { status: 400 })
    }

    return Response.json(await stub.setHarness(harness))
  }

  return Response.json({ error: 'Method not allowed' }, { status: 405 })
}

async function sessionTeam(request: Request, env: ShuttleEnv, runId: string): Promise<Response> {
  if (!runId) {
    return Response.json({ error: 'Invalid session id' }, { status: 400 })
  }

  const stub = loomsStub(env.LOOMS_RUN, runId)

  if (request.method === 'GET') {
    return Response.json(await stub.getTeam())
  }

  if (request.method === 'PUT' || request.method === 'POST') {
    const body = (await request.json().catch(() => null)) as { team?: unknown } | null
    const team = parseTeam(body?.team)

    if (!team) {
      return Response.json({ error: 'invalid team' }, { status: 400 })
    }

    const saved = await stub.setTeam(team)

    // The change takes effect on the conductor's next turn. Put it in the session's history so
    // "was Codex on the team when I asked?" can be answered from the events.
    await stub
      .signal([
        {
          type: 'shuttle.team.changed',
          payload: { ...saved.team },
          idempotencyKey: `team:${crypto.randomUUID()}`,
        },
      ])
      .catch(() => {})

    return Response.json(saved)
  }

  return Response.json({ error: 'Method not allowed' }, { status: 405 })
}

/** The model and effort each vendor agent runs on in this session. */
async function sessionVendorModels(
  request: Request,
  env: ShuttleEnv,
  runId: string,
): Promise<Response> {
  if (!runId) {
    return Response.json({ error: 'Invalid session id' }, { status: 400 })
  }

  const session = loomsStub(env.LOOMS_RUN, runId)
  const workspace = loomsStub(env.LOOMS_RUN, workspaceRunId(env))

  const current = async () => ({
    // A session's own choice wins. Without one it runs on the most recent choice made anywhere.
    choices: {
      ...(await workspace.getVendorModelChoices()).choices,
      ...(await session.getVendorModelChoices()).choices,
    },
  })

  if (request.method === 'GET') {
    return Response.json(await current())
  }

  if (request.method === 'PUT' || request.method === 'POST') {
    const body = (await request.json().catch(() => null)) as { harness?: unknown } | null
    const harness = parseHarness(body?.harness)
    const choice = parseVendorModelChoice(body)

    if (!harness || !isVendorHarness(harness) || !vendorHarnessInfo(harness).supported || !choice) {
      return Response.json({ error: 'unknown agent or invalid model' }, { status: 400 })
    }

    await session.setVendorModelChoice(harness, choice)
    // Remembered as the starting point for sessions that have not picked a model.
    await workspace.setVendorModelChoice(harness, choice)

    return Response.json(await current())
  }

  return Response.json({ error: 'Method not allowed' }, { status: 405 })
}

async function listSessions(env: ShuttleEnv): Promise<Response> {
  if (!env.REPLICA) {
    return Response.json({
      sessions: [],
      note: 'D1 REPLICA is not configured. Start sessions normally; the list populates after you bind D1.',
    })
  }

  const result = await env.REPLICA.prepare(
    `SELECT run_id, kind, definition_name, status, correlation_id, updated_at, attributes_json
     FROM looms_run_index
     WHERE kind = 'shuttle-session' OR definition_name = 'coding'
     ORDER BY updated_at DESC
     LIMIT 50`,
  ).all()

  return Response.json({ sessions: result.results ?? [] })
}

async function sessionTree(env: ShuttleEnv, sessionId: string): Promise<Response> {
  if (!env.REPLICA) {
    return Response.json({
      sessionId,
      runs: [],
      note: 'D1 REPLICA is not configured.',
    })
  }

  const result = await env.REPLICA.prepare(
    `SELECT run_id, kind, definition_name, status, parent_run_id, correlation_id, updated_at
     FROM looms_run_index
     WHERE correlation_id = ? OR run_id = ? OR parent_run_id = ?
     ORDER BY updated_at DESC
     LIMIT 100`,
  )
    .bind(sessionId, sessionId, sessionId)
    .all()

  return Response.json({ sessionId, runs: result.results ?? [] })
}

async function ensurePlaybook(env: ShuttleEnv): Promise<Response> {
  const runId = playbookRunId(env)
  const stub = loomsStub(env.LOOMS_RUN, runId)

  try {
    const status = await stub.status()

    if (status) {
      return Response.json({ runId, status: status.status, created: false })
    }
  } catch {
    // Not started yet.
  }

  await stub.launch({
    kind: 'reflect-playbook',
    definitionName: 'playbook',
    input: { title: 'Shuttle playbook' },
  })

  return Response.json({ runId, created: true })
}

const emptyPlaybook = { version: 0, lessons: [], proposed: {} }

async function getPlaybook(env: ShuttleEnv): Promise<Response> {
  const runId = playbookRunId(env)
  const stub = loomsStub(env.LOOMS_RUN, runId)

  const request = new Request(`https://shuttle.internal/runs/${runId}/projections/activePlaybook`, {
    method: 'GET',
  })

  const response = await stub.fetch(request)

  if (response.ok) {
    const body = (await response.json()) as { value?: unknown }
    return Response.json({ runId, playbook: body.value ?? emptyPlaybook })
  }

  return Response.json({
    runId,
    playbook: emptyPlaybook,
    note: 'Playbook run not started yet. POST /playbook/ensure first.',
  })
}

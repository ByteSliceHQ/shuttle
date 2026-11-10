import { playbookRunId } from '../config'
import type { ShuttleEnv } from '../env'
import { loomsStub } from '../looms-stub'

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

  if (request.method === 'GET' && url.pathname === '/playbook') {
    return getPlaybook(env)
  }

  if (request.method === 'POST' && url.pathname === '/playbook/ensure') {
    return ensurePlaybook(env)
  }

  return null
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

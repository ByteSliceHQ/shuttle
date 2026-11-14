import { getAuth } from '../auth/auth'
import {
  codeStorageClient,
  codeStorageConfigured,
  deleteScratchRepo,
  scratchRepoName,
} from '../codestorage/client'
import { playbookRunId, workspaceRunId } from '../config'
import type { ShuttleEnv } from '../env'
import { isVendorHarness, parseHarness } from '../harness'
import { loomsStub } from '../looms-stub'
import { say } from '../session/signals'
import { parseTeam } from '../team'
import { canShareSession, isPublicSession, type Actor, type SessionAccess } from '../tenancy/access'
import { scopedRunId } from '../tenancy/run-id'
import { vendorHarnessInfo } from '../vendor/harnesses'
import { parseVendorModelChoice } from '../vendor/models'
import { moveListings, signalListings } from '../workspace/listings'
import { archiveSession, renameSession } from '../workspace/module'

/**
 * Session and playbook routes. `index.ts` has already checked that `actor` may open the session
 * a `/sessions/<id>/…` path names.
 */
export async function handleShuttleRoutes(
  request: Request,
  env: ShuttleEnv,
  actor: Actor,
): Promise<Response | null> {
  const url = new URL(request.url)
  const { orgId } = actor

  if (request.method === 'GET' && url.pathname === '/sessions') {
    return listSessions(env, orgId)
  }

  const accessMatch = url.pathname.match(/^\/sessions\/([^/]+)\/access$/)

  if (accessMatch) {
    return sessionAccess(request, env, actor, decodeURIComponent(accessMatch[1] ?? ''))
  }

  const sayMatch = url.pathname.match(/^\/sessions\/([^/]+)\/say$/)

  if (request.method === 'POST' && sayMatch) {
    return sessionSay(request, env, actor, decodeURIComponent(sayMatch[1] ?? ''))
  }

  const listingMatch = url.pathname.match(/^\/sessions\/([^/]+)\/(rename|archive)$/)

  if (request.method === 'POST' && listingMatch) {
    return sessionListing(
      request,
      env,
      actor,
      decodeURIComponent(listingMatch[1] ?? ''),
      listingMatch[2] === 'archive' ? 'archive' : 'rename',
    )
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
    return sessionVendorModels(request, env, orgId, decodeURIComponent(vendorModelsMatch[1] ?? ''))
  }

  const stopMatch = url.pathname.match(/^\/sessions\/([^/]+)\/stop$/)

  if (request.method === 'POST' && stopMatch) {
    return sessionStop(request, env, decodeURIComponent(stopMatch[1] ?? ''))
  }

  if (request.method === 'GET' && url.pathname === '/playbook') {
    return getPlaybook(env, orgId)
  }

  if (request.method === 'POST' && url.pathname === '/playbook/ensure') {
    return ensurePlaybook(env, orgId)
  }

  return null
}

/**
 * Who may open a session.
 *
 *   GET /sessions/:id/access                  owner, members, visibility, and whether the caller
 *                                             may change them
 *   PUT /sessions/:id/access                  { memberIds?, visibility? }, owner only
 */
async function sessionAccess(
  request: Request,
  env: ShuttleEnv,
  actor: Actor,
  runId: string,
): Promise<Response> {
  const session = loomsStub(env.LOOMS_RUN, runId)
  const access = await session.getAccess()

  const describe = (current: SessionAccess | null) => ({
    ownerId: current?.ownerId ?? null,
    memberIds: current?.memberIds ?? [],
    visibility: isPublicSession(current) ? 'public' : 'private',
    canShare: canShareSession(current, actor),
  })

  if (request.method === 'GET') {
    return Response.json(describe(access))
  }

  if (request.method !== 'PUT') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 })
  }

  if (!access || !canShareSession(access, actor)) {
    return Response.json({ error: 'Only the session owner can change this' }, { status: 403 })
  }

  const body = (await request.json().catch(() => null)) as {
    memberIds?: unknown
    visibility?: unknown
  } | null

  const memberIds = body?.memberIds ?? access.memberIds
  const visibility = body?.visibility ?? access.visibility

  if (!Array.isArray(memberIds) || !memberIds.every((id) => typeof id === 'string')) {
    return Response.json({ error: 'memberIds must be a list of user ids' }, { status: 400 })
  }

  if (visibility !== 'private' && visibility !== 'public') {
    return Response.json({ error: 'visibility must be private or public' }, { status: 400 })
  }

  // A session can only be shared with people in its organization.
  const { members } = await getAuth(env).api.listMembers({
    headers: request.headers,
    query: { organizationId: actor.orgId, limit: 1000 },
  })

  const inOrg = new Set(members.map((member) => member.userId))

  if (!memberIds.every((id) => inOrg.has(id))) {
    return Response.json({ error: 'Everyone must be in this organization' }, { status: 400 })
  }

  const saved = await session.setAccess({ ownerId: access.ownerId, memberIds, visibility })

  // The access record is the one that is enforced; the listings follow it.
  await moveListings(env, actor.orgId, runId, access, saved)

  return Response.json(describe(saved))
}

const INTERJECTION_KINDS = ['question', 'idea', 'constraint', 'correction', 'task', 'stop'] as const

/**
 * Sends a person's message into a session.
 *
 *   POST /sessions/:id/say    { messageId, text, forceKind?, targetThreadId? }
 *
 * The author is taken from the sign-in, so a message can never be sent in someone else's name.
 */
async function sessionSay(
  request: Request,
  env: ShuttleEnv,
  actor: Actor,
  runId: string,
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    messageId?: unknown
    text?: unknown
    forceKind?: unknown
    targetThreadId?: unknown
  } | null

  const messageId = typeof body?.messageId === 'string' ? body.messageId.trim() : ''
  const text = typeof body?.text === 'string' ? body.text : ''
  const forceKind = INTERJECTION_KINDS.find((kind) => kind === body?.forceKind)

  if (!messageId || messageId.length > 128 || !text.trim()) {
    return Response.json({ error: 'messageId and text are required' }, { status: 400 })
  }

  if (body?.forceKind !== undefined && !forceKind) {
    return Response.json({ error: 'unknown message kind' }, { status: 400 })
  }

  const message = say({
    messageId,
    text,
    ...(forceKind ? { forceKind } : {}),
    ...(typeof body?.targetThreadId === 'string' ? { targetThreadId: body.targetThreadId } : {}),
    author: { id: actor.userId, name: actor.name || actor.email },
  })

  await loomsStub(env.LOOMS_RUN, runId).signal([
    { ...message, origin: { type: 'external', actorId: actor.userId } },
  ])

  return Response.json({ messageId })
}

/**
 * Renames or archives a session wherever it is listed. Anyone who can open the session may.
 *
 *   POST /sessions/:id/rename    { title }
 *   POST /sessions/:id/archive
 */
async function sessionListing(
  request: Request,
  env: ShuttleEnv,
  actor: Actor,
  runId: string,
  action: 'rename' | 'archive',
): Promise<Response> {
  const access = await loomsStub(env.LOOMS_RUN, runId).getAccess()

  if (action === 'archive') {
    await signalListings(env, actor.orgId, access, [archiveSession({ runId })])

    // An archived session is finished with. If it had a repository of its own on Code Storage,
    // only there to carry it between sandboxes, that goes too.
    if (codeStorageConfigured(env)) {
      await deleteScratchRepo(codeStorageClient(env), scratchRepoName(actor.orgId, runId)).catch(
        (cause: unknown) => {
          console.warn('could not delete the scratch repository', cause)
        },
      )
    }

    return Response.json({ runId, archived: true })
  }

  const body = (await request.json().catch(() => null)) as { title?: unknown } | null
  const title = typeof body?.title === 'string' ? body.title.trim() : ''

  if (!title || title.length > 120) {
    return Response.json({ error: 'title must be 1 to 120 characters' }, { status: 400 })
  }

  await signalListings(env, actor.orgId, access, [renameSession({ runId, title })])

  return Response.json({ runId, title })
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
  orgId: string,
  runId: string,
): Promise<Response> {
  if (!runId) {
    return Response.json({ error: 'Invalid session id' }, { status: 400 })
  }

  const session = loomsStub(env.LOOMS_RUN, runId)
  const workspace = loomsStub(env.LOOMS_RUN, workspaceRunId(env, orgId))

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

async function listSessions(env: ShuttleEnv, orgId: string): Promise<Response> {
  if (!env.REPLICA) {
    return Response.json({
      sessions: [],
      note: 'D1 REPLICA is not configured. Start sessions normally; the list populates after you bind D1.',
    })
  }

  // Every run id in an organization starts with the same prefix.
  const orgPrefix = scopedRunId(orgId, '')

  const result = await env.REPLICA.prepare(
    `SELECT run_id, kind, definition_name, status, correlation_id, updated_at, attributes_json
     FROM looms_run_index
     WHERE (kind = 'shuttle-session' OR definition_name = 'coding')
       AND substr(run_id, 1, ?) = ?
     ORDER BY updated_at DESC
     LIMIT 50`,
  )
    .bind(orgPrefix.length, orgPrefix)
    .all()

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

async function ensurePlaybook(env: ShuttleEnv, orgId: string): Promise<Response> {
  const runId = playbookRunId(env, orgId)
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

async function getPlaybook(env: ShuttleEnv, orgId: string): Promise<Response> {
  const runId = playbookRunId(env, orgId)
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

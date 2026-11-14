import type { InterjectionKind } from './session-feed'

/**
 * What to tell someone when a request fails: what they were trying to do, and the Worker's own
 * reason when it gave a readable one. Never the raw response body.
 */
async function requestFailure(action: string, response: Response): Promise<Error> {
  const body = (await response.text().catch(() => '')).trim()
  let reason: string | undefined

  try {
    const parsed: unknown = JSON.parse(body)

    if (
      parsed &&
      typeof parsed === 'object' &&
      'error' in parsed &&
      typeof parsed.error === 'string'
    ) {
      reason = parsed.error
    }
  } catch {
    // Not JSON. Short plain text is a reason; a page of HTML is not.
    if (body && body.length <= 160 && !body.startsWith('<')) {
      reason = body
    }
  }

  if (response.status === 404 && (!reason || /^not found$/i.test(reason))) {
    return new Error(`${action}: this session could not be found.`)
  }

  return new Error(reason ? `${action}: ${reason}` : `${action} (${response.status}).`)
}

export interface PlaybookLesson {
  id: string
  text: string
  scope: string
  evidence: { runId: string; seq: number }[]
  sourceRunId: string
}

export interface PlaybookState {
  version: number
  lessons: PlaybookLesson[]
  proposed?: Record<string, Omit<PlaybookLesson, 'id'>>
}

export interface IndexedSession {
  readonly runId: string
  readonly status?: string
}

async function postJson(path: string, body: object): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function fetchPlaybook(): Promise<{ runId: string; playbook: PlaybookState }> {
  await fetch('/playbook/ensure', { method: 'POST' })
  const response = await fetch('/playbook')

  if (!response.ok) {
    throw new Error(`Failed to load playbook: ${response.status}`)
  }

  return (await response.json()) as { runId: string; playbook: PlaybookState }
}

export async function fetchSessions(): Promise<{ sessions: IndexedSession[] }> {
  const response = await fetch('/sessions')

  if (!response.ok) {
    return { sessions: [] }
  }

  const body = (await response.json()) as { sessions?: Record<string, unknown>[] }

  return {
    sessions: (body.sessions ?? []).flatMap((row) =>
      typeof row.run_id === 'string'
        ? [{ runId: row.run_id, status: typeof row.status === 'string' ? row.status : undefined }]
        : [],
    ),
  }
}

/** Named Looms signals take their input wrapped as `{ input }`. */
async function signal(runId: string, name: string, input: object, failure: string) {
  const response = await postJson(`/runs/${runId}/signals/${name}`, { input })

  if (!response.ok) {
    throw new Error(`${failure}: ${response.status} ${await response.text()}`)
  }
}

export async function stopSession(runId: string, threadId: string): Promise<void> {
  const response = await fetch(
    `/sessions/${encodeURIComponent(runId)}/stop?threadId=${encodeURIComponent(threadId)}`,
    { method: 'POST' },
  )

  if (!response.ok) {
    throw await requestFailure('Failed to stop agent', response)
  }
}

/**
 * Sends a message into a session. The Worker records who sent it from the sign-in, so it goes
 * through a route of its own and not straight to the run as a signal.
 */
export async function say(
  runId: string,
  text: string,
  forceKind?: InterjectionKind,
  targetThreadId?: string,
) {
  const messageId = crypto.randomUUID()

  const response = await postJson(`/sessions/${encodeURIComponent(runId)}/say`, {
    messageId,
    text,
    ...(forceKind ? { forceKind } : {}),
    ...(targetThreadId ? { targetThreadId } : {}),
  })

  if (!response.ok) {
    throw await requestFailure('Failed to send message', response)
  }

  return { messageId }
}

/** Stops one agent thread in a session, and every thread beneath it. */
export async function stopThread(runId: string, threadId: string): Promise<void> {
  const response = await postJson(
    `/sessions/${encodeURIComponent(runId)}/threads/${encodeURIComponent(threadId)}/stop`,
    {},
  )

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null

    throw new Error(body?.error ?? `Could not stop the agent: ${response.status}`)
  }
}

export async function reroute(
  runId: string,
  messageId: string,
  kind: InterjectionKind,
  targetThreadId?: string,
) {
  await signal(
    runId,
    'shuttle/reroute',
    { messageId, kind, ...(targetThreadId ? { targetThreadId } : {}) },
    'Failed to reroute',
  )
}

/** Resolves an agent's `ask_user` gate; `null` lets the agent use its own judgment. */
export async function answerQuestion(runId: string, approvalId: string, answer: string | null) {
  const choice =
    answer === null
      ? { actionId: 'defer', outcome: 'reject' }
      : { actionId: 'answer', outcome: 'approve', payload: { answer } }

  await signal(runId, 'approval/decision', { approvalId, choice }, 'Failed to answer')
}

export async function decideApproval(
  runId: string,
  approvalId: string,
  outcome: 'approve' | 'reject',
) {
  await signal(
    runId,
    'approval/decision',
    { approvalId, choice: outcome },
    'Failed to decide approval',
  )
}

/** Resolve a structured approval gate (PR publish / review submit). */
export async function decideStructuredApproval(
  runId: string,
  approvalId: string,
  choice: {
    readonly actionId: string
    readonly outcome: 'approve' | 'reject'
    readonly payload?: Record<string, unknown>
  },
) {
  await signal(runId, 'approval/decision', { approvalId, choice }, 'Failed to decide approval')
}

export async function fetchLlmModel(runId: string): Promise<{ model: string }> {
  const response = await fetch(`/sessions/${encodeURIComponent(runId)}/llm-model`)

  if (!response.ok) {
    throw new Error(`Failed to load model: ${response.status}`)
  }

  return (await response.json()) as { model: string }
}

export async function setLlmModel(runId: string, model: string): Promise<{ model: string }> {
  const response = await fetch(`/sessions/${encodeURIComponent(runId)}/llm-model`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model }),
  })

  if (!response.ok) {
    throw await requestFailure('Failed to set model', response)
  }

  return (await response.json()) as { model: string }
}

export type HarnessId = 'shuttle' | 'codex' | 'claude-code'

export interface Connection {
  readonly harness: Exclude<HarnessId, 'shuttle'>
  readonly label: string
  readonly connected: boolean
  readonly updatedAt: number | null
}

export type TeamPreset =
  | 'none'
  | 'codex-builds-claude-reviews'
  | 'claude-builds-codex-reviews'
  | 'claude-plans-codex-implements'

/** Who Shuttle's conductor may hand work to in a session. */
export interface Team {
  readonly workers: boolean
  readonly codex: boolean
  readonly claudeCode: boolean
  readonly preset: TeamPreset
}

export const DEFAULT_TEAM: Team = { workers: true, codex: false, claudeCode: false, preset: 'none' }

export interface ConnectionsState {
  /** The harness new sessions start on. */
  readonly defaultHarness: HarnessId
  /** The team new Shuttle sessions start with. */
  readonly defaultTeam: Team
  /** Subscriptions need the container sandbox; `memory` cannot run the agents. */
  readonly mode: 'memory' | 'container'
  /** False when the worker has no key to encrypt stored sign-ins with. */
  readonly canStore: boolean
  readonly connections: readonly Connection[]
}

export type LoginEvent =
  | {
      readonly type: 'login_prompt'
      readonly url: string
      readonly code: string
      readonly needsCode?: boolean
    }
  | { readonly type: 'login_done'; readonly success: boolean; readonly error?: string }

async function connectionsRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/workspace/connections${path}`, {
    ...init,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
  })

  const body = (await response.json().catch(() => ({}))) as T & { error?: string }

  if (!response.ok) {
    throw new Error(body.error ?? `Request failed: ${response.status}`)
  }

  return body
}

export function fetchConnections(): Promise<ConnectionsState> {
  return connectionsRequest('')
}

export function setDefaultHarness(harness: HarnessId): Promise<{ defaultHarness: HarnessId }> {
  return setSessionDefaults({ harness })
}

/** What new sessions start with. Either part may be left out to keep it as it is. */
export function setSessionDefaults(defaults: {
  harness?: HarnessId
  team?: Team
}): Promise<{ defaultHarness: HarnessId; defaultTeam: Team }> {
  return connectionsRequest('/default', { method: 'PUT', body: JSON.stringify(defaults) })
}

export function startLogin(harness: string): Promise<{ loginId: string }> {
  return connectionsRequest(`/${harness}/login`, { method: 'POST' })
}

export function followLogin(
  harness: string,
  loginId: string,
  offset: number,
): Promise<{
  events: LoginEvent[]
  offset: number
  done: boolean
  connected: boolean
  error?: string
}> {
  return connectionsRequest(`/${harness}/login/${loginId}?offset=${offset}`)
}

export function sendLoginCode(harness: string, loginId: string, code: string): Promise<unknown> {
  return connectionsRequest(`/${harness}/login/${loginId}/code`, {
    method: 'POST',
    body: JSON.stringify({ code }),
  })
}

export function cancelLogin(harness: string, loginId: string): Promise<unknown> {
  return connectionsRequest(`/${harness}/login/${loginId}/cancel`, { method: 'POST' })
}

export function disconnectHarness(harness: string): Promise<unknown> {
  return connectionsRequest(`/${harness}`, { method: 'DELETE' })
}

export async function fetchSessionHarness(runId: string): Promise<{ harness: HarnessId }> {
  const response = await fetch(`/sessions/${encodeURIComponent(runId)}/harness`, {
    headers: { accept: 'application/json' },
  })

  if (!response.ok) {
    throw new Error(`Failed to load the session's agent: ${response.status}`)
  }

  return (await response.json()) as { harness: HarnessId }
}

export async function setSessionHarness(
  runId: string,
  harness: HarnessId,
): Promise<{ harness: HarnessId }> {
  const response = await fetch(`/sessions/${encodeURIComponent(runId)}/harness`, {
    method: 'PUT',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ harness }),
  })

  if (!response.ok) {
    throw await requestFailure('Failed to switch agent', response)
  }

  return (await response.json()) as { harness: HarnessId }
}

export async function fetchSessionTeam(runId: string): Promise<{ team: Team }> {
  const response = await fetch(`/sessions/${encodeURIComponent(runId)}/team`, {
    headers: { accept: 'application/json' },
  })

  if (!response.ok) {
    throw new Error(`Failed to load the session's team: ${response.status}`)
  }

  return (await response.json()) as { team: Team }
}

export async function setSessionTeam(runId: string, team: Team): Promise<{ team: Team }> {
  const response = await fetch(`/sessions/${encodeURIComponent(runId)}/team`, {
    method: 'PUT',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ team }),
  })

  if (!response.ok) {
    throw await requestFailure('Failed to change the team', response)
  }

  return (await response.json()) as { team: Team }
}

export type VendorHarnessId = Exclude<HarnessId, 'shuttle'>

/** A model a vendor agent offers under the developer's own subscription. */
export interface VendorModel {
  readonly id: string
  readonly label: string
  readonly description: string
  /** Reasoning efforts the model accepts, lowest first. Empty when it takes none. */
  readonly efforts: readonly string[]
  readonly defaultEffort?: string
  /** True for the model the agent uses when none is chosen. */
  readonly isDefault?: boolean
}

/** Either part may be absent, which leaves that part to the agent's own default. */
export interface VendorModelChoice {
  readonly model?: string
  readonly effort?: string
}

export type VendorModelChoices = Partial<Record<VendorHarnessId, VendorModelChoice>>

export function fetchVendorModels(
  harness: VendorHarnessId,
): Promise<{ models: readonly VendorModel[] }> {
  return connectionsRequest(`/${encodeURIComponent(harness)}/models`)
}

export async function fetchSessionVendorModels(
  runId: string,
): Promise<{ choices: VendorModelChoices }> {
  const response = await fetch(`/sessions/${encodeURIComponent(runId)}/vendor-models`)

  if (!response.ok) {
    throw new Error(`Failed to load agent models: ${response.status}`)
  }

  return (await response.json()) as { choices: VendorModelChoices }
}

export async function setSessionVendorModel(
  runId: string,
  harness: VendorHarnessId,
  choice: VendorModelChoice,
): Promise<{ choices: VendorModelChoices }> {
  const response = await fetch(`/sessions/${encodeURIComponent(runId)}/vendor-models`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ harness, ...choice }),
  })

  if (!response.ok) {
    throw await requestFailure('Failed to set agent model', response)
  }

  return (await response.json()) as { choices: VendorModelChoices }
}

export type SessionVisibility = 'private' | 'public'

/**
 * Who can open a session. A private one opens for its owner and members only; a public one for
 * everyone in the organization. `canShare` says whether the caller may change any of this.
 */
export interface SessionAccess {
  readonly ownerId: string | null
  readonly memberIds: readonly string[]
  readonly visibility: SessionVisibility
  readonly canShare: boolean
}

export async function fetchSessionAccess(runId: string): Promise<SessionAccess> {
  const response = await fetch(`/sessions/${encodeURIComponent(runId)}/access`)

  if (!response.ok) {
    throw new Error(`Failed to load who can open this session: ${response.status}`)
  }

  return (await response.json()) as SessionAccess
}

/** Changes who a session is shared with, its visibility, or both. */
export async function updateSessionAccess(
  runId: string,
  change: { readonly memberIds?: readonly string[]; readonly visibility?: SessionVisibility },
): Promise<SessionAccess> {
  const response = await fetch(`/sessions/${encodeURIComponent(runId)}/access`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(change),
  })

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null

    throw new Error(body?.error ?? `Failed to change who can open the session: ${response.status}`)
  }

  return (await response.json()) as SessionAccess
}

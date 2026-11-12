import type { InterjectionKind } from './session-feed'

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

export async function startSession(input: {
  goal: string
  repoUrl?: string | null
}): Promise<{ runId: string }> {
  const playbook = await fetchPlaybook()
  const lessons = playbook.playbook.lessons ?? []

  const response = await postJson('/runs/launch', {
    kind: 'shuttle-session',
    definitionName: 'coding',
    input: {
      goal: input.goal,
      repoUrl: input.repoUrl ?? null,
      playbookRunId: playbook.runId,
      playbookVersion: playbook.playbook.version ?? 0,
      lessons,
    },
    attributes: {
      sessionId: crypto.randomUUID(),
      repo: input.repoUrl ?? 'local',
      playbookVersion: String(playbook.playbook.version ?? 0),
      kind: 'shuttle-session',
    },
  })

  if (!response.ok) {
    throw new Error(`Failed to start session: ${response.status} ${await response.text()}`)
  }

  return (await response.json()) as { runId: string }
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
    throw new Error(`Failed to stop agent: ${response.status} ${await response.text()}`)
  }
}

export async function say(
  runId: string,
  text: string,
  forceKind?: InterjectionKind,
  targetThreadId?: string,
) {
  const messageId = crypto.randomUUID()

  await signal(
    runId,
    'shuttle/say',
    {
      messageId,
      text,
      ...(forceKind ? { forceKind } : {}),
      ...(targetThreadId ? { targetThreadId } : {}),
    },
    'Failed to send message',
  )

  return { messageId }
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
    throw new Error(`Failed to set model: ${response.status} ${await response.text()}`)
  }

  return (await response.json()) as { model: string }
}

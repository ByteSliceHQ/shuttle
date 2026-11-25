import { orgOfRun, scopedRunId } from '@shuttle/api'
import type { RunState } from '@swirls/looms/core'

import { ensureNamedWorkspace, ensureWorkspaceQuietly } from '../bootstrap'
import { personalWorkspaceRunId, workspaceRunId } from '../config'
import { parseHarness, type HarnessId } from '../harness'
import { loomsStub, type LoomsRunStub } from '../looms-stub'
import { resolveHost, type ShuttleHost } from '../ports/host'
import { actorOfActing, orgOfActing, ownerOfActing, type ActingFor } from '../ports/identity'
import { admitSessionStart } from '../ports/session-start'
import type { JsonObjectBuilder } from '../session/json-object'
import { say } from '../session/signals'
import type { InterjectionKind } from '../session/thread'
import { canOpenSession, type Actor, type SessionAccess } from '../tenancy/access'
import { NO_FOLDER } from '../workspace/scope'
import { requestSession } from '../workspace/signals'
import {
  openQuestions,
  sessionOutcome,
  type QuestionKind,
  type SessionOutcome,
  type SessionQuestion,
} from './outcome'

/** A repository for a session to work in. The host knows its GitHub App installation. */
export interface HeadlessRepository {
  readonly installationId: number
  /** `owner/name`. */
  readonly fullName: string
  readonly defaultBranch: string
  readonly private: boolean
}

export interface HeadlessSessionRequest {
  /** Who the session is for. A person's session is private to them; an organization's is open to it. */
  readonly acting: ActingFor
  /** What to do, in the words a person would give it. */
  readonly brief: string
  readonly repositories: readonly HeadlessRepository[]
  /**
   * What the host wants back later, such as the work item this session is for. Shuttle carries it
   * on the session and reads none of it. At most 32 entries; keys up to 64 characters, values up
   * to 2048.
   */
  readonly metadata?: Readonly<Record<string, string>>
  /** Names the session, so asking again with the same key finds it instead of starting another. */
  readonly idempotencyKey?: string
  /**
   * Which agent works the session. A vendor harness runs on the credential the host's
   * `credentials` port names, so a host that supplies an organization's own API keys picks the
   * vendor they are for. Left out, the session runs on the deployment's default harness.
   */
  readonly harness?: HarnessId
}

export interface HeadlessSession {
  readonly runId: string
}

export const MAX_METADATA_ENTRIES = 32
export const MAX_METADATA_KEY = 64
export const MAX_METADATA_VALUE = 2048

const REPO_FULL_NAME = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{1,64}$/

export class HeadlessRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HeadlessRequestError'
  }
}

function checkMetadata(metadata: Readonly<Record<string, string>>): void {
  const entries = Object.entries(metadata)

  if (entries.length > MAX_METADATA_ENTRIES) {
    throw new HeadlessRequestError(`metadata has more than ${MAX_METADATA_ENTRIES} entries`)
  }

  for (const [key, value] of entries) {
    if (key === '' || key.length > MAX_METADATA_KEY) {
      throw new HeadlessRequestError(`metadata keys are 1 to ${MAX_METADATA_KEY} characters`)
    }

    if (value.length > MAX_METADATA_VALUE) {
      throw new HeadlessRequestError(`metadata values are at most ${MAX_METADATA_VALUE} characters`)
    }
  }
}

function linkedRepos(repositories: readonly HeadlessRepository[]) {
  return repositories.map((repo) => {
    const parts = REPO_FULL_NAME.exec(repo.fullName)

    if (parts === null) {
      throw new HeadlessRequestError(`"${repo.fullName}" is not a repository name (owner/name)`)
    }

    return {
      installationId: repo.installationId,
      owner: parts[1] ?? '',
      name: parts[2] ?? '',
      fullName: repo.fullName,
      defaultBranch: repo.defaultBranch,
      private: repo.private,
    }
  })
}

function accessFor(acting: ActingFor): SessionAccess {
  const owner = ownerOfActing(acting)

  return owner === null
    ? { ownerId: null, memberIds: [], visibility: 'public' }
    : { ownerId: owner, memberIds: [], visibility: 'private' }
}

/** Whether a session already recorded as `recorded` is the one `access` would start. */
function sameAccess(recorded: SessionAccess, access: SessionAccess): boolean {
  return recorded.ownerId === access.ownerId && recorded.visibility === access.visibility
}

/**
 * Starts a session from a repository and a brief, with no folder. The session works the way one a
 * person starts does: the same agents, in a sandbox of its own, publishing through the same
 * approval. It answers once the session is requested, not when it has finished; read where it
 * stands with {@link headlessOutcome}.
 *
 * The host's `sessionStart` port decides first, and a refusal is thrown as
 * `SessionStartRefusedError` before anything is created. Asking again with the same idempotency
 * key returns the session already started, changes nothing on it and does not ask the port again;
 * a key that names a session someone else started is refused.
 */
export async function startHeadlessSession(
  host: ShuttleHost,
  request: HeadlessSessionRequest,
): Promise<HeadlessSession> {
  const { env, ports } = resolveHost(host)
  const brief = request.brief.trim()

  if (brief === '') {
    throw new HeadlessRequestError('a session needs a brief')
  }

  if (request.repositories.length === 0) {
    throw new HeadlessRequestError('a session needs at least one repository')
  }

  if (request.idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(request.idempotencyKey)) {
    throw new HeadlessRequestError('an idempotency key is letters, digits, "_" and "-"')
  }

  if (request.metadata !== undefined) {
    checkMetadata(request.metadata)
  }

  if (request.harness !== undefined && parseHarness(request.harness) === null) {
    throw new HeadlessRequestError(`"${request.harness}" is not a harness Shuttle can run`)
  }

  const repos = linkedRepos(request.repositories)
  const orgId = orgOfActing(request.acting)
  const runId = scopedRunId(orgId, `session_${request.idempotencyKey ?? crypto.randomUUID()}`)
  const access = accessFor(request.acting)

  // Only a key can name a session that is already there. Without one the session is new, and
  // nothing is reached before the host has allowed it.
  const recorded =
    request.idempotencyKey === undefined ? null : await loomsStub(env.LOOMS_RUN, runId).getAccess()

  if (recorded !== null && !sameAccess(recorded, access)) {
    // A key names one session in the organization. Someone else's is not theirs to take over.
    throw new HeadlessRequestError('that idempotency key names a session someone else started')
  }

  // The host is asked once for a session: asking again with the same key is not another start,
  // so a port that counts starts counts this one once.
  if (recorded === null) {
    await admitSessionStart(ports.sessionStart, {
      kind: 'host',
      orgId,
      acting: request.acting,
      repos: repos.map((repo) => repo.fullName),
      metadata: request.metadata,
    })
  }

  const owner = ownerOfActing(request.acting)

  // A person's session is listed in their own workspace; an organization's, in the shared one.
  const listedIn =
    owner === null ? workspaceRunId(env, orgId) : personalWorkspaceRunId(env, orgId, owner)

  await Promise.all([ensureWorkspaceQuietly(env, orgId), ensureNamedWorkspace(env, listedIn)])

  if (recorded === null) {
    const session = loomsStub(env.LOOMS_RUN, runId)

    // Recorded before the session exists, so there is no moment when it is open to everyone, and
    // its first turn already runs on the harness the host chose.
    await session.setAccess(access)

    if (request.harness !== undefined) {
      await session.setHarness(request.harness)
    }
  }

  // Asking again leaves the session's access and harness as they are. The request is sent again,
  // which the workspace ignores for a session it already has, so a start that stopped before it
  // got this far is finished.

  await loomsStub(env.LOOMS_RUN, listedIn).signal([
    requestSession({
      runId,
      folderId: NO_FOLDER,
      goal: brief,
      lessons: [],
      playbookVersion: 0,
      playbookRunId: null,
      ownerId: owner ?? undefined,
      repos,
      hostMetadata: request.metadata,
    }),
  ])

  return { runId }
}

/**
 * Where a headless session stands: working, completed with its pull requests, or blocked. It
 * answers for any run it is given: the host decides who may read which session before it calls.
 */
export async function headlessOutcome(host: ShuttleHost, runId: string): Promise<SessionOutcome> {
  const { env } = resolveHost(host)

  return sessionOutcome(await loomsStub(env.LOOMS_RUN, runId).getRun())
}

/**
 * An answer to a blocked session's question: words for a `question`, a decision for a
 * `publish-pull-request` or a `submit-review`, or null to leave it to the agent's judgment.
 */
export type HeadlessAnswer =
  | { readonly text: string }
  | { readonly decision: 'approve' | 'reject' }
  | null

/** The action a decision takes on each kind of question, as the approval itself names them. */
const DECISION_ACTIONS: Record<
  Exclude<QuestionKind, 'question'>,
  { readonly approve: string; readonly reject: string }
> = {
  'publish-pull-request': { approve: 'approve', reject: 'discard' },
  'submit-review': { approve: 'submit', reject: 'discard' },
}

/**
 * The decision `answer` makes on `question`. An answer of the wrong shape is refused, so words
 * meant for an agent never approve a pull request, and a bare approval never stands in for an
 * answer in words.
 */
function decisionFor(question: SessionQuestion, answer: HeadlessAnswer): JsonObjectBuilder {
  if (question.kind === 'question') {
    if (answer === null) {
      return { actionId: 'defer', outcome: 'reject' }
    }

    if ('text' in answer) {
      return { actionId: 'answer', outcome: 'approve', payload: { answer: answer.text } }
    }

    throw new HeadlessRequestError('a question is answered with { text }, or null')
  }

  if (answer === null || !('decision' in answer)) {
    throw new HeadlessRequestError(`a ${question.kind} is decided with { decision }`)
  }

  return { actionId: DECISION_ACTIONS[question.kind][answer.decision], outcome: answer.decision }
}

/** The question `approvalId` names among those `run` has open. */
function openQuestion(run: RunState, approvalId: string): SessionQuestion {
  const question = openQuestions(run).find((open) => open.approvalId === approvalId)

  if (question === undefined) {
    throw new HeadlessRequestError('that session has no open question with that id')
  }

  return question
}

/**
 * Answers the question a blocked session is waiting on. `null` has the agent use its own
 * judgment, as a person choosing "use your judgment" does. A pull request proposal, or a review
 * an agent asks to submit, is decided with `approve` or `reject`. An answer that does not fit the
 * question, or names one the session does not have open, is refused with `HeadlessRequestError`.
 *
 * `acting` has to be able to open the session: anyone in its organization for an organization's
 * session, and for a person's only that person or someone they shared it with.
 */
export async function answerHeadlessQuestion(
  host: ShuttleHost,
  runId: string,
  approvalId: string,
  answer: HeadlessAnswer,
  acting: ActingFor,
): Promise<void> {
  const { session, actor } = await openSession(host, runId, acting)

  const decided: JsonObjectBuilder = {
    approvalId,
    ...decisionFor(openQuestion(await session.getRun(), approvalId), answer),
  }

  // Recorded as decided by whoever the host acts for, as a decision made in the app is.
  await session.signal([
    {
      type: 'approval.decided',
      payload: decided,
      origin: { type: 'external', actorId: actor.userId },
    },
  ])
}

/**
 * The session `runId` names, for `acting` to act on. Refused with `HeadlessRequestError` when it
 * is another organization's, or a person's that `acting` cannot open.
 */
async function openSession(
  host: ShuttleHost,
  runId: string,
  acting: ActingFor,
): Promise<{ readonly session: LoomsRunStub; readonly actor: Actor }> {
  const { env } = resolveHost(host)

  if (orgOfActing(acting) !== orgOfRun(runId)) {
    throw new HeadlessRequestError('that session belongs to another organization')
  }

  const actor = actorOfActing(acting)
  const session = loomsStub(env.LOOMS_RUN, runId)

  if (!canOpenSession(await session.getAccess(), actor)) {
    throw new HeadlessRequestError('that session is private to someone else')
  }

  return { session, actor }
}

/** A message to a session, as a person types one into it. */
export interface HeadlessMessage {
  readonly text: string
  /** Names the message, so sending it again with the same id adds nothing. Left out, one is made. */
  readonly messageId?: string
  /**
   * What the message is, when the host already knows: a `task` is more work, a `correction`
   * redirects what is under way, a `stop` ends it. Left out, the session works it out.
   */
  readonly kind?: InterjectionKind
}

/**
 * Sends a session a message, as a person typing into it does: more work for a completed session,
 * or a correction to one that is working. It answers once the message is recorded, not when the
 * session has acted on it; read where it stands with {@link headlessOutcome}. A question the
 * session is blocked on is answered with {@link answerHeadlessQuestion}, not with a message.
 *
 * The message is recorded as from whoever the host acts for, and `acting` has to be able to open
 * the session, as for an answer.
 */
export async function sendHeadlessMessage(
  host: ShuttleHost,
  runId: string,
  message: HeadlessMessage,
  acting: ActingFor,
): Promise<{ readonly messageId: string }> {
  const { session, actor } = await openSession(host, runId, acting)

  if (message.text.trim() === '') {
    throw new HeadlessRequestError('a message needs text')
  }

  const messageId = message.messageId ?? crypto.randomUUID()

  const said = say({
    messageId,
    text: message.text,
    forceKind: message.kind,
    author: { id: actor.userId, name: actor.name === '' ? actor.email : actor.name },
  })

  await session.signal([{ ...said, origin: { type: 'external', actorId: actor.userId } }], {
    wake: 'schedule',
  })

  return { messageId }
}

const ENDED = new Set(['completed', 'failed', 'cancelled'])

/**
 * Stops the turn each of a session's agents is in, as the stop button does: what they were doing
 * is abandoned, and the session stays open for the next message. With `threadId`, only that
 * agent's turn is stopped. It answers with the agent threads it stopped, which is none for a
 * session whose agents had all finished.
 *
 * `acting` has to be able to open the session, as for an answer.
 */
export async function stopHeadlessSession(
  host: ShuttleHost,
  runId: string,
  acting: ActingFor,
  threadId?: string,
): Promise<{ readonly stopped: readonly string[] }> {
  const { session, actor } = await openSession(host, runId, acting)
  const run = await session.getRun()

  const agents = Object.values(run.threads)
    .filter((thread) => thread.kind === 'agent' && !ENDED.has(thread.status))
    .map((thread) => thread.threadId)

  if (threadId !== undefined && !agents.includes(threadId)) {
    throw new HeadlessRequestError('that session has no agent at work with that thread id')
  }

  const stopped = threadId === undefined ? agents : [threadId]

  if (stopped.length > 0) {
    const at = Date.now()

    await session.signal(
      stopped.map((id) => ({
        type: 'agent.turn.stopped',
        threadId: id,
        payload: {},
        idempotencyKey: `headless-stop:${id}:${at}`,
        origin: { type: 'external' as const, actorId: actor.userId },
      })),
    )
  }

  return { stopped }
}

/** The headless API of one host, for whatever launches its sessions. */
export interface HeadlessSessions {
  start(request: HeadlessSessionRequest): Promise<HeadlessSession>
  outcome(runId: string): Promise<SessionOutcome>
  answer(
    runId: string,
    approvalId: string,
    answer: HeadlessAnswer,
    acting: ActingFor,
  ): Promise<void>
  message(
    runId: string,
    message: HeadlessMessage,
    acting: ActingFor,
  ): Promise<{ readonly messageId: string }>
  stop(
    runId: string,
    acting: ActingFor,
    threadId?: string,
  ): Promise<{ readonly stopped: readonly string[] }>
}

export function headlessSessions(host: ShuttleHost): HeadlessSessions {
  return {
    start: (request) => startHeadlessSession(host, request),
    outcome: (runId) => headlessOutcome(host, runId),
    answer: (runId, approvalId, answer, acting) =>
      answerHeadlessQuestion(host, runId, approvalId, answer, acting),
    message: (runId, message, acting) => sendHeadlessMessage(host, runId, message, acting),
    stop: (runId, acting, threadId) => stopHeadlessSession(host, runId, acting, threadId),
  }
}

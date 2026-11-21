import { ensureNamedWorkspace, ensureWorkspaceQuietly } from '../bootstrap'
import { personalWorkspaceRunId, workspaceRunId } from '../config'
import { parseHarness, type HarnessId } from '../harness'
import { loomsStub } from '../looms-stub'
import { resolveHost, type ShuttleHost } from '../ports/host'
import { actorOfActing, orgOfActing, ownerOfActing, type ActingFor } from '../ports/identity'
import { admitSessionStart } from '../ports/session-start'
import type { JsonObjectBuilder } from '../session/json-object'
import type { SessionAccess } from '../tenancy/access'
import { orgOfRun, scopedRunId } from '../tenancy/run-id'
import { NO_FOLDER } from '../workspace/scope'
import { requestSession } from '../workspace/signals'
import { sessionOutcome, type SessionOutcome } from './outcome'

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
 * key returns the session already started and changes nothing on it; a key that names a session
 * someone else started is refused.
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

  await admitSessionStart(ports.sessionStart, {
    kind: 'host',
    orgId,
    acting: request.acting,
    repos: repos.map((repo) => repo.fullName),
    metadata: request.metadata,
  })

  const owner = ownerOfActing(request.acting)

  // A person's session is listed in their own workspace; an organization's, in the shared one.
  const listedIn =
    owner === null ? workspaceRunId(env, orgId) : personalWorkspaceRunId(env, orgId, owner)

  await Promise.all([ensureWorkspaceQuietly(env, orgId), ensureNamedWorkspace(env, listedIn)])

  const runId = scopedRunId(orgId, `session_${request.idempotencyKey ?? crypto.randomUUID()}`)

  const session = loomsStub(env.LOOMS_RUN, runId)
  const access = accessFor(request.acting)
  const recorded = await session.getAccess()

  if (recorded === null) {
    // Recorded before the session exists, so there is no moment when it is open to everyone, and
    // its first turn already runs on the harness the host chose.
    await session.setAccess(access)

    if (request.harness !== undefined) {
      await session.setHarness(request.harness)
    }
  } else if (!sameAccess(recorded, access)) {
    // A key names one session in the organization. Someone else's is not theirs to take over.
    throw new HeadlessRequestError('that idempotency key names a session someone else started')
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

/** Where a headless session stands: working, completed with its pull requests, or blocked. */
export async function headlessOutcome(host: ShuttleHost, runId: string): Promise<SessionOutcome> {
  const { env } = resolveHost(host)

  return sessionOutcome(await loomsStub(env.LOOMS_RUN, runId).getRun())
}

/**
 * An answer to a blocked session's question: words for a `question`, a decision for a
 * `publish-pull-request`, or null to leave it to the agent's judgment.
 */
export type HeadlessAnswer =
  | { readonly text: string }
  | { readonly decision: 'approve' | 'reject' }
  | null

/**
 * Answers the question a blocked session is waiting on. `null` has the agent use its own
 * judgment, as a person choosing "use your judgment" does. A question that is a pull request
 * proposal is decided with `approve` or `reject`.
 */
export async function answerHeadlessQuestion(
  host: ShuttleHost,
  runId: string,
  approvalId: string,
  answer: HeadlessAnswer,
  acting: ActingFor,
): Promise<void> {
  const { env } = resolveHost(host)

  if (orgOfActing(acting) !== orgOfRun(runId)) {
    throw new HeadlessRequestError('that session belongs to another organization')
  }

  const actor = actorOfActing(acting)

  const decided: JsonObjectBuilder = { approvalId }

  if (answer === null) {
    decided.actionId = 'defer'
    decided.outcome = 'reject'
  } else if ('text' in answer) {
    decided.actionId = 'answer'
    decided.outcome = 'approve'
    decided.payload = { answer: answer.text }
  } else {
    decided.actionId = answer.decision === 'approve' ? 'approve' : 'discard'
    decided.outcome = answer.decision
  }

  // Recorded as decided by whoever the host acts for, as a decision made in the app is.
  await loomsStub(env.LOOMS_RUN, runId).signal([
    {
      type: 'approval.decided',
      payload: decided,
      origin: { type: 'external', actorId: actor.userId },
    },
  ])
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
}

export function headlessSessions(host: ShuttleHost): HeadlessSessions {
  return {
    start: (request) => startHeadlessSession(host, request),
    outcome: (runId) => headlessOutcome(host, runId),
    answer: (runId, approvalId, answer, acting) =>
      answerHeadlessQuestion(host, runId, approvalId, answer, acting),
  }
}

import { Predicate } from 'effect'

import { isJsonObject, type JsonObject, type JsonValue, type RunState } from '@swirls/looms/core'

import type { ApprovalKind } from '../ports/approvals'
import { deriveActivityFromRunState } from '../workspace/activity-state'
import type { SessionActivity } from '../workspace/module'

/** A pull request the session opened. */
export interface SessionPullRequest {
  readonly repo: string
  readonly number: number
  readonly url: string
  readonly draft: boolean
}

/** A question the session has put to a person and cannot go on without. */
export interface SessionQuestion {
  /** Pass this back to `answerHeadlessQuestion`. */
  readonly approvalId: string
  readonly title: string
  readonly description: string | null
  /**
   * What is being asked. A `question` is answered in words, or left to the agent's judgment. A
   * `publish-pull-request` is a proposal, approved or rejected.
   */
  readonly kind: 'question' | ApprovalKind
  /** When a decision stops being accepted, as epoch milliseconds. Null: it waits for as long as it takes. */
  readonly expiresAt: number | null
}

/**
 * Where a headless session stands, in the terms a host cares about:
 *
 * - `working`: it has more to do, and nothing for the host to act on yet.
 * - `completed`: it has finished what it was asked, with the pull requests it opened (possibly
 *   none, when the brief did not call for changes).
 * - `blocked`: it cannot go on until `question` is answered.
 * - `failed`: it stopped on an error.
 *
 * Read it whenever the host wants to know, such as on a schedule or when it is told the session
 * went quiet. `completed` and `blocked` are states of an open session, not endings: a blocked
 * session goes on once answered, and a completed one takes another brief as a message.
 */
export type SessionOutcome =
  | { readonly state: 'working' }
  | { readonly state: 'completed'; readonly pullRequests: readonly SessionPullRequest[] }
  | {
      readonly state: 'blocked'
      readonly question: SessionQuestion
      readonly pullRequests: readonly SessionPullRequest[]
    }
  | {
      readonly state: 'failed'
      readonly error: string | null
      readonly pullRequests: readonly SessionPullRequest[]
    }

/** A question an agent asked with `ask_user`, as the run holds it: a wait on its answer. */
export interface AskedQuestion {
  readonly approvalId: string
  /** The question as the agent put it, when the run still shows the call that asked. */
  readonly title: string | null
  readonly description: string | null
}

/** What the outcome is read from. */
export interface OutcomeSource {
  readonly activity: SessionActivity
  /** The session thread's own state: what the session knows about its pull requests. */
  readonly state: JsonObject
  /** What the session's agents are waiting on a person for. */
  readonly asked?: readonly AskedQuestion[]
}

/** The repository a stack key names: `owner/name`, or `owner/name#2` for a session's second stack. */
function repoOfStackKey(key: string): string {
  const mark = key.indexOf('#')

  return mark === -1 ? key : key.slice(0, mark)
}

function asObject(value: JsonValue | undefined): JsonObject {
  return isJsonObject(value) ? value : {}
}

export function pullRequestsOf(state: JsonObject): SessionPullRequest[] {
  const stacks = asObject(state.stacks)

  return Object.entries(stacks).flatMap(([key, stack]) => {
    const layers = asObject(stack).layers

    if (!Array.isArray(layers)) {
      return []
    }

    return layers.flatMap((layer) => {
      const pull = asObject(asObject(layer).pull)

      return Predicate.isNumber(pull.number) && Predicate.isString(pull.url)
        ? [
            {
              repo: repoOfStackKey(key),
              number: pull.number,
              url: pull.url,
              draft: pull.draft === true,
            },
          ]
        : []
    })
  })
}

/**
 * What the session is waiting on a person for. A pull request proposal comes first: it is the
 * session's own, and nothing else moves until it is decided.
 */
export function questionOf(source: Omit<OutcomeSource, 'activity'>): SessionQuestion | null {
  const proposal = asObject(source.state.pendingPrPublish)

  if (proposal.status === 'awaiting_approval' && Predicate.isString(proposal.approvalId)) {
    return {
      approvalId: proposal.approvalId,
      title: 'Publish this pull request?',
      description: Predicate.isString(proposal.title) ? proposal.title : null,
      kind: 'publish-pull-request',
      expiresAt: Predicate.isNumber(proposal.expiresAt) ? proposal.expiresAt : null,
    }
  }

  const [asked] = source.asked ?? []

  if (asked === undefined) {
    return null
  }

  return {
    approvalId: asked.approvalId,
    title: asked.title ?? 'Needs your decision',
    description: asked.description,
    kind: 'question',
    expiresAt: null,
  }
}

/** The approval requests an agent thread has made from its tool calls, by approval id. */
function requestsOf(threadState: JsonValue | undefined): Map<string, JsonObject> {
  const pending = asObject(threadState).pendingEffects

  const requests = (Array.isArray(pending) ? pending : [])
    .flatMap((entry) => {
      const effects = asObject(entry).effects

      return Array.isArray(effects) ? effects.map(asObject) : []
    })
    .filter((effect) => effect.type === 'approval.request')
    .map((effect) => asObject(effect.input))

  return new Map(
    requests.flatMap((request) =>
      Predicate.isString(request.approvalId) ? [[request.approvalId, request] as const] : [],
    ),
  )
}

/** The questions the run's agents have asked and are still waiting on. */
export function askedOf(run: RunState): AskedQuestion[] {
  return Object.values(run.waits).flatMap((wait) => {
    const owner = run.threads[wait.threadId]

    if (
      !('type' in wait.on) ||
      wait.on.type !== 'approval.decided' ||
      owner === undefined ||
      owner.status === 'completed' ||
      owner.status === 'failed' ||
      owner.status === 'cancelled'
    ) {
      return []
    }

    const approvalId = asObject(wait.on.match).approvalId

    if (!Predicate.isString(approvalId)) {
      return []
    }

    const { title, description } = requestsOf(owner.state).get(approvalId) ?? {}

    return [
      {
        approvalId,
        title: Predicate.isString(title) ? title : null,
        description: Predicate.isString(description) ? description : null,
      },
    ]
  })
}

/**
 * The outcome for a session whose activity and state are known. An approval the session has open
 * is what it is blocked on, whatever else is going on: the agent that proposed a pull request is
 * still inside its tool call, and a proposal made from the session itself leaves nothing running.
 */
export function outcomeOf(source: OutcomeSource): SessionOutcome {
  const pullRequests = pullRequestsOf(source.state)

  if (source.activity === 'error') {
    const error = asObject(source.state.error).message

    return { state: 'failed', error: Predicate.isString(error) ? error : null, pullRequests }
  }

  const question = questionOf(source)

  if (question !== null) {
    return { state: 'blocked', question, pullRequests }
  }

  switch (source.activity) {
    case 'working':
      return { state: 'working' }

    case 'needs_input':
      return {
        state: 'blocked',
        question: {
          approvalId: '',
          title: 'Needs your decision',
          description: null,
          kind: 'question',
          expiresAt: null,
        },
        pullRequests,
      }

    case 'idle':
      return { state: 'completed', pullRequests }

    default: {
      const exhaustive: never = source.activity
      return exhaustive
    }
  }
}

/** The outcome of a session, read from its run. A run with no session thread yet is working. */
export function sessionOutcome(run: RunState): SessionOutcome {
  const rootId = run.rootThreadId
  const root = rootId === null ? undefined : run.threads[rootId]

  if (root === undefined) {
    return { state: 'working' }
  }

  const outcome = outcomeOf({
    activity: deriveActivityFromRunState(run),
    state: asObject(root.state),
    asked: askedOf(run),
  })

  // A session that failed outright, not in its conductor, says why on its thread, or on the
  // thread or effect that failed under it (a model call refused, say).
  return outcome.state === 'failed' && outcome.error === null
    ? { ...outcome, error: root.error ?? failureOf(run) }
    : outcome
}

/** Why a run failed when its root thread does not say: a failed thread's error, else an effect's last. */
function failureOf(run: RunState): string | null {
  const threads = Object.values(run.threads)
  const thread = threads.find((record) => record.status === 'failed' && record.error !== null)

  if (thread?.error != null) {
    return thread.error
  }

  const effect = Object.values(run.effectExecutions).find((record) => record.lastError !== null)

  return effect?.lastError ?? null
}

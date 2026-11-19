import { Predicate } from 'effect'

import { isJsonObject, type JsonObject, type JsonValue, type RunState } from '@swirls/looms/core'

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

/** What the outcome is read from, apart from the run itself. */
export interface OutcomeSource {
  readonly activity: SessionActivity
  /** The session thread's own state: what the session knows about its pull requests and questions. */
  readonly state: JsonObject
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

export function questionOf(state: JsonObject): SessionQuestion | null {
  const [first] = Object.entries(asObject(state.openApprovals))

  if (first === undefined) {
    return null
  }

  const [approvalId, open] = first
  const { title, description } = asObject(open)

  return {
    approvalId,
    title: Predicate.isString(title) ? title : 'Needs your decision',
    description: Predicate.isString(description) ? description : null,
  }
}

/** The outcome for a session whose activity and state are known. */
export function outcomeOf(source: OutcomeSource): SessionOutcome {
  const pullRequests = pullRequestsOf(source.state)

  switch (source.activity) {
    case 'working':
      return { state: 'working' }

    case 'error': {
      const error = asObject(source.state.error).message

      return { state: 'failed', error: Predicate.isString(error) ? error : null, pullRequests }
    }

    case 'needs_input':
      return {
        state: 'blocked',
        question: questionOf(source.state) ?? {
          approvalId: '',
          title: 'Needs your decision',
          description: null,
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

  return outcomeOf({ activity: deriveActivityFromRunState(run), state: asObject(root.state) })
}

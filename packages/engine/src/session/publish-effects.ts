import { Predicate } from 'effect'

import { emit, invoke, isJsonObject, type JsonValue, type RuntimeEffect } from '@swirls/looms/core'

import { hasExpired, POLICY_DECIDER } from '../ports/approvals'
import { shuttleModule } from './scope'
import { stacksAsJson, type PendingPrPublish } from './stack-state'

function asObject(value: JsonValue | undefined): { [key: string]: JsonValue } {
  return isJsonObject(value) ? value : {}
}

/** An `approval.decided` payload: who decided which gate, how, and any fields they filled in. */
export interface ApprovalDecision {
  readonly approvalId: string
  readonly actionId: string
  readonly outcome: 'approve' | 'reject'
  readonly payload?: JsonValue | undefined
}

/** Who sent an event: the signed-in person, for one that came from a browser. */
export interface EventOriginLike {
  readonly origin?: { readonly type: string; readonly actorId?: string | undefined } | undefined
}

/** Whether an event is a decision the host's approval policy made, not a person. */
export function decidedByPolicy(event: EventOriginLike): boolean {
  return event.origin?.type === 'external' && event.origin.actorId === POLICY_DECIDER
}

/** The Shuttle user an event was sent by, or null when it did not come from a person. */
export function actorOfEvent(event: EventOriginLike): string | null {
  const origin = event.origin

  if (
    origin?.type !== 'external' ||
    origin.actorId === undefined ||
    origin.actorId === '' ||
    origin.actorId === POLICY_DECIDER
  ) {
    return null
  }

  return origin.actorId
}

/**
 * The `approval.decided` event for a gate the host's approval policy settled, as an effect
 * returns it: addressed to the session's own thread, where a person's decision arrives, and
 * recorded as decided by the policy.
 */
export function policyDecided(sessionThreadId: string, decision: ApprovalDecision) {
  return {
    type: 'approval.decided' as const,
    payload: decision,
    threadId: sessionThreadId,
    origin: { type: 'external' as const, actorId: POLICY_DECIDER },
  }
}

export interface PublishSessionSlice {
  readonly pendingPrPublish: PendingPrPublish | null
  readonly discardedPrApprovalId: string | null
  /** Why the gate was closed without publishing, for the message the agent is told. */
  readonly discardedPrReason?: 'rejected' | 'policy' | 'expired' | null
  readonly stacks: Parameters<typeof stacksAsJson>[0]
}

/** What `withPrApprovalDecision` is told about a decision besides its payload. */
export interface ApprovalContext {
  readonly at?: number
  readonly approvedBy?: string | null
  /** True when the host's approval policy made the decision, so a rejection is said to be its. */
  readonly byPolicy?: boolean
}

/** Apply an approval decision to a pending PR publish, or return null if unrelated. */
export function withPrApprovalDecision<S extends PublishSessionSlice>(
  state: S,
  payload: ApprovalDecision,
  /**
   * When the decision was recorded, to hold it against the approval's expiry, and the Shuttle user
   * who made it, whose GitHub account then authors the commits.
   */
  { at = Date.now(), approvedBy = null, byPolicy = false }: ApprovalContext = {},
): S | null {
  const approvalId = payload.approvalId
  const pending = state.pendingPrPublish

  if (pending === null || pending.approvalId !== approvalId) {
    return null
  }

  if (hasExpired(pending.expiresAt, at)) {
    return {
      ...state,
      pendingPrPublish: null,
      discardedPrApprovalId: approvalId,
      discardedPrReason: 'expired',
    }
  }

  if (payload.outcome !== 'approve') {
    return {
      ...state,
      pendingPrPublish: null,
      discardedPrApprovalId: approvalId,
      discardedPrReason: byPolicy ? 'policy' : 'rejected',
    }
  }

  const fields = asObject(payload.payload)
  const actionId = payload.actionId
  const title = Predicate.isString(fields.title) ? fields.title : pending.title
  const body = Predicate.isString(fields.body) ? fields.body : pending.body

  const repos = Array.isArray(fields.repos)
    ? fields.repos.filter(Predicate.isString)
    : [...pending.repos]

  // `update` pushes to a pull request that already exists, which keeps its own draft state.
  const draft =
    actionId === 'publish'
      ? false
      : Predicate.isBoolean(fields.draft)
        ? fields.draft
        : pending.draft

  return {
    ...state,
    pendingPrPublish: {
      approvalId: pending.approvalId,
      threadId: pending.threadId,
      title,
      body,
      draft,
      repos,
      repo: pending.repo,
      stackId: pending.stackId,
      layer: pending.layer,
      parentPull: pending.parentPull,
      restacks: pending.restacks,
      status: 'publishing',
      approvedBy,
    },
  }
}

/** What the proposing agent is told when its proposal is closed without publishing. */
const DISCARD_MESSAGES = {
  rejected: 'The user discarded this pull request proposal; nothing was published.',
  policy:
    "The host's approval policy rejected this pull request proposal; nothing was published. Do not propose it again unless something has changed.",
  expired:
    'This pull request proposal was not approved in time and has expired; nothing was published.',
} as const

export function appendPrPublishEffects(state: PublishSessionSlice, effects: RuntimeEffect[]): void {
  if (state.pendingPrPublish?.status === 'publishing') {
    const pending = state.pendingPrPublish

    effects.push(
      invoke(
        'shuttle.publishPullRequest',
        {
          approvalId: pending.approvalId,
          threadId: pending.threadId,
          title: pending.title,
          body: pending.body,
          draft: pending.draft,
          repos: [...pending.repos],
          repo: pending.repo,
          stackId: pending.stackId,
          layer: pending.layer,
          stacks: stacksAsJson(state.stacks),
          approvedBy: pending.approvedBy ?? null,
        },
        `publish_pr_${pending.approvalId}`,
      ),
    )
  }

  if (state.discardedPrApprovalId !== null && state.discardedPrApprovalId !== '') {
    effects.push(
      emit(
        shuttleModule.input('pr.discarded', {
          approvalId: state.discardedPrApprovalId,
          message: DISCARD_MESSAGES[state.discardedPrReason ?? 'rejected'],
        }),
        `pr_discarded_${state.discardedPrApprovalId}`,
      ),
    )
  }
}

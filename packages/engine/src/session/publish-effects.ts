import { Predicate } from 'effect'

import { emit, invoke, isJsonObject, type JsonValue, type RuntimeEffect } from '@swirls/looms/core'

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

export interface PublishSessionSlice {
  readonly pendingPrPublish: PendingPrPublish | null
  readonly discardedPrApprovalId: string | null
  readonly stacks: Parameters<typeof stacksAsJson>[0]
}

/** Apply an approval decision to a pending PR publish, or return null if unrelated. */
export function withPrApprovalDecision<S extends PublishSessionSlice>(
  state: S,
  payload: ApprovalDecision,
): S | null {
  const approvalId = payload.approvalId
  const pending = state.pendingPrPublish

  if (pending === null || pending.approvalId !== approvalId) {
    return null
  }

  if (payload.outcome !== 'approve') {
    return { ...state, pendingPrPublish: null, discardedPrApprovalId: approvalId }
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
    },
  }
}

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
          message: 'The user discarded this pull request proposal; nothing was published.',
        }),
        `pr_discarded_${state.discardedPrApprovalId}`,
      ),
    )
  }
}

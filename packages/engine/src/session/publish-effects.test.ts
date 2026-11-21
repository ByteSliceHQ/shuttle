import { describe, expect, test } from 'bun:test'

import type { RuntimeEffect } from '@swirls/looms/core'

import {
  actorOfEvent,
  appendPrPublishEffects,
  withPrApprovalDecision,
  type PublishSessionSlice,
} from './publish-effects'

function awaiting(expiresAt: number | null = null): PublishSessionSlice {
  return {
    pendingPrPublish: {
      approvalId: 'pr_publish_1',
      threadId: null,
      title: 'feat: a change',
      body: '',
      draft: false,
      repos: ['shuttle'],
      repo: 'shuttle',
      stackId: 1,
      layer: 1,
      parentPull: null,
      restacks: [],
      status: 'awaiting_approval',
      expiresAt,
    },
    discardedPrApprovalId: null,
    stacks: {},
  }
}

const approve = { approvalId: 'pr_publish_1', actionId: 'publish', outcome: 'approve' } as const

describe('withPrApprovalDecision', () => {
  test('an approval with no expiry is accepted whenever it arrives', () => {
    const next = withPrApprovalDecision(awaiting(), approve, { at: Number.MAX_SAFE_INTEGER })

    expect(next?.pendingPrPublish?.status).toBe('publishing')
  })

  test('an approval inside its expiry publishes', () => {
    const next = withPrApprovalDecision(awaiting(1_000), approve, { at: 1_000 })

    expect(next?.pendingPrPublish?.status).toBe('publishing')
  })

  test('an approval after its expiry is refused and nothing is published', () => {
    const next = withPrApprovalDecision(awaiting(1_000), approve, { at: 1_001 })

    expect(next?.pendingPrPublish).toBeNull()
    expect(next?.discardedPrApprovalId).toBe('pr_publish_1')
    expect(next?.discardedPrReason).toBe('expired')
  })

  test('a discard is recorded as rejected', () => {
    const next = withPrApprovalDecision(
      awaiting(),
      { ...approve, actionId: 'discard', outcome: 'reject' },
      { at: 5 },
    )

    expect(next?.discardedPrReason).toBe('rejected')
  })

  test('a decision for another approval is not its business', () => {
    expect(
      withPrApprovalDecision(awaiting(), { ...approve, approvalId: 'other' }, { at: 5 }),
    ).toBeNull()
  })
})

describe('actorOfEvent', () => {
  test('is the person a browser event was recorded as', () => {
    expect(actorOfEvent({ origin: { type: 'external', actorId: 'user_1' } })).toBe('user_1')
  })

  test('is null for an event no person sent', () => {
    expect(actorOfEvent({ origin: { type: 'system' } })).toBeNull()
    expect(actorOfEvent({ origin: { type: 'external' } })).toBeNull()
    expect(actorOfEvent({})).toBeNull()
  })
})

describe('publishing as the person who approved it', () => {
  test('the approver is passed to the publish effect', () => {
    const next = withPrApprovalDecision(awaiting(), approve, { approvedBy: 'user_1' })
    const effects: RuntimeEffect[] = []

    expect(next?.pendingPrPublish?.approvedBy).toBe('user_1')

    appendPrPublishEffects(next ?? awaiting(), effects)

    expect(effects).toHaveLength(1)
    expect(JSON.stringify(effects[0])).toContain('"approvedBy":"user_1"')
  })

  test('an approval with no person behind it publishes with no approver', () => {
    const next = withPrApprovalDecision(awaiting(), approve)
    const effects: RuntimeEffect[] = []

    appendPrPublishEffects(next ?? awaiting(), effects)

    expect(JSON.stringify(effects[0])).toContain('"approvedBy":null')
  })
})

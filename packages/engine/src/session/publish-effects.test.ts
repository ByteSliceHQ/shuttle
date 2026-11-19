import { describe, expect, test } from 'bun:test'

import { withPrApprovalDecision, type PublishSessionSlice } from './publish-effects'

function awaiting(expiresAt: number | null): PublishSessionSlice {
  return {
    pendingPrPublish: {
      approvalId: 'pr_publish_1',
      threadId: null,
      title: 'Fix it',
      body: '',
      draft: true,
      repos: ['glue'],
      repo: 'glue',
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
    const next = withPrApprovalDecision(awaiting(null), approve, Number.MAX_SAFE_INTEGER)

    expect(next?.pendingPrPublish?.status).toBe('publishing')
  })

  test('an approval inside its expiry publishes', () => {
    const next = withPrApprovalDecision(awaiting(1_000), approve, 1_000)

    expect(next?.pendingPrPublish?.status).toBe('publishing')
  })

  test('an approval after its expiry is refused and nothing is published', () => {
    const next = withPrApprovalDecision(awaiting(1_000), approve, 1_001)

    expect(next?.pendingPrPublish).toBeNull()
    expect(next?.discardedPrApprovalId).toBe('pr_publish_1')
    expect(next?.discardedPrReason).toBe('expired')
  })

  test('a discard is recorded as rejected', () => {
    const next = withPrApprovalDecision(
      awaiting(null),
      { ...approve, actionId: 'discard', outcome: 'reject' },
      5,
    )

    expect(next?.discardedPrReason).toBe('rejected')
  })

  test('a decision for another approval is not its business', () => {
    expect(
      withPrApprovalDecision(awaiting(null), { ...approve, approvalId: 'other' }, 5),
    ).toBeNull()
  })
})

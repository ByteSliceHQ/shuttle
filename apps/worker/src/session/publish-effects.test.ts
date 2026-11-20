import { describe, expect, test } from 'bun:test'

import type { RuntimeEffect } from '@swirls/looms/core'

import {
  actorOfEvent,
  appendPrPublishEffects,
  withPrApprovalDecision,
  type PublishSessionSlice,
} from './publish-effects'

const awaiting: PublishSessionSlice = {
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
  },
  discardedPrApprovalId: null,
  stacks: {},
}

const approve = { approvalId: 'pr_publish_1', actionId: 'publish', outcome: 'approve' } as const

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
    const next = withPrApprovalDecision(awaiting, approve, 'user_1')
    const effects: RuntimeEffect[] = []

    expect(next?.pendingPrPublish?.approvedBy).toBe('user_1')

    appendPrPublishEffects(next ?? awaiting, effects)

    expect(effects).toHaveLength(1)
    expect(JSON.stringify(effects[0])).toContain('"approvedBy":"user_1"')
  })

  test('an approval with no person behind it publishes with no approver', () => {
    const next = withPrApprovalDecision(awaiting, approve)
    const effects: RuntimeEffect[] = []

    appendPrPublishEffects(next ?? awaiting, effects)

    expect(JSON.stringify(effects[0])).toContain('"approvedBy":null')
  })
})

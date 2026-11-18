import { describe, expect, test } from 'bun:test'

import type { JsonValue } from '@swirls/looms/core'

import type { SessionEvent } from '../events/event-catalog'
import { pullRequestState } from './open-pull-request'
import { sessionFeed } from './session-feed'

let seq = 0

function event(type: string, payload: JsonValue, threadId = 'thr_conductor'): SessionEvent {
  seq += 1
  return {
    id: `evt_${seq}`,
    runId: 'run_test',
    seq,
    ts: 1_000 + seq,
    type,
    payload,
    threadId,
    origin: { type: 'system' },
  }
}

const fold = (events: readonly SessionEvent[]) =>
  events.reduce((state, next) => sessionFeed.reduce(state, next), sessionFeed.initialState)

const gate = event('approval.requested', { approvalId: 'pr_publish_1', title: 'Publish?' })

describe('pullRequestState', () => {
  test('nothing proposed yet', () => {
    expect(pullRequestState(fold([]))).toEqual({ awaiting: null, publishing: false })
  })

  test('a card waiting for approval', () => {
    expect(pullRequestState(fold([gate]))).toEqual({ awaiting: 'pr_publish_1', publishing: false })
  })

  test('approved and publishing, then published', () => {
    const approved = event('approval.decided', { approvalId: 'pr_publish_1', outcome: 'approve' })

    expect(pullRequestState(fold([gate, approved]))).toEqual({ awaiting: null, publishing: true })

    const published = event('shuttle.pr.published', {
      approvalId: 'pr_publish_1',
      pulls: [{ fullName: 'acme/app', number: 3, url: 'https://github.com/acme/app/pull/3' }],
    })

    expect(pullRequestState(fold([gate, approved, published]))).toEqual({
      awaiting: null,
      publishing: false,
    })
  })

  test('discarded', () => {
    const discarded = event('approval.decided', { approvalId: 'pr_publish_1', outcome: 'reject' })

    expect(pullRequestState(fold([gate, discarded]))).toEqual({ awaiting: null, publishing: false })
  })
})

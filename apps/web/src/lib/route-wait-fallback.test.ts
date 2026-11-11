import { describe, expect, test } from 'bun:test'

import type { SessionEvent } from './event-catalog'
import {
  deriveRouteWaitFallback,
  initialSessionActivityState,
  shouldShowRouteWaitFallback,
} from './session-activity'
import { sessionFeed } from './session-feed'

let seq = 0

function event(
  type: string,
  payload: Record<string, unknown>,
  threadId: string | null = 'thr_worker',
): SessionEvent {
  seq += 1
  return {
    id: `evt_${seq}`,
    runId: 'run_test',
    seq,
    ts: 10_000 + seq,
    type,
    payload,
    threadId,
    origin: { type: 'system' },
  }
}

describe('route wait fallback', () => {
  test('shows after five seconds without a route', () => {
    expect(shouldShowRouteWaitFallback(1_000, false, 6_000)).toBe(true)
    expect(shouldShowRouteWaitFallback(1_000, false, 4_000)).toBe(false)
    expect(shouldShowRouteWaitFallback(1_000, true, 9_000)).toBe(false)
  })

  test('derives running tool name and elapsed time from the feed', () => {
    const feed = [
      event('shuttle.user.said', { messageId: 'm1', text: 'What changed?' }),
      event('agent.tool_call.requested', {
        turn: 1,
        toolCall: { id: 'c1', name: 'bash', arguments: { command: 'sleep 9' } },
      }),
    ].reduce(sessionFeed.reduce, sessionFeed.initialState)

    const fallback = deriveRouteWaitFallback({
      messageTs: 10_001,
      hasRoute: false,
      now: 70_000,
      activity: { ...initialSessionActivityState, activity: 'working' },
      feed,
    })

    expect(fallback).toMatchObject({
      threadId: 'thr_worker',
      toolName: 'bash',
      elapsedMs: 59_998,
    })
  })
})

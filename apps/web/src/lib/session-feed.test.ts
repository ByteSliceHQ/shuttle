import { describe, expect, test } from 'bun:test'

import type { JsonValue } from '@swirls/looms/core'

import type { SessionEvent } from './event-catalog'
import { sessionFeed, streamingText } from './session-feed'

let seq = 0

function event(
  type: string,
  payload: JsonValue,
  threadId: string | null = 'thr_root',
): SessionEvent {
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

function fold(events: readonly SessionEvent[]) {
  return events.reduce(sessionFeed.reduce, sessionFeed.initialState)
}

describe('session feed', () => {
  test('opens with the goal from the root thread', () => {
    const feed = fold([event('runtime.thread.started', { input: { goal: 'Ship it' } })])

    expect(feed.items).toHaveLength(1)
    expect(feed.items[0]).toMatchObject({ kind: 'user', goal: true, text: 'Ship it' })
    expect(feed.brief).toEqual([{ version: 1, text: 'Ship it' }])
  })

  test('keeps steers that land before the routed event', () => {
    const feed = fold([
      event('shuttle.user.said', { messageId: 'm1', text: 'Use zod' }),
      event('shuttle.intake.started', { messageId: 'm1', childThreadId: 'thr_intake' }),
      event(
        'agent.steered',
        {
          turn: 0,
          messageId: 'm1',
          message: { role: 'user', content: 'Use zod' },
          interrupt: true,
        },
        'thr_worker',
      ),
      event('shuttle.routed', {
        messageId: 'm1',
        kind: 'correction',
        targetThreadId: 'thr_worker',
        summary: 'interrupted thr_worker',
      }),
    ])

    expect(feed.routes.m1?.kind).toBe('correction')
    expect(feed.deliveries.m1).toEqual([{ threadId: 'thr_worker', interrupt: true }])
    expect(feed.classifying.m1).toBeUndefined()
  })

  test('groups consecutive tool calls per agent and settles results', () => {
    const call = (id: string, name: string) =>
      event(
        'agent.tool_call.requested',
        { turn: 1, toolCall: { id, name, arguments: { path: `/workspace/${id}` } } },
        'thr_worker',
      )

    const feed = fold([
      call('c1', 'read_file'),
      call('c2', 'edit_file'),
      event(
        'agent.tool.result',
        { turn: 1, toolCallId: 'c2', name: 'edit_file', result: null, error: 'no match' },
        'thr_worker',
      ),
    ])

    expect(feed.items).toHaveLength(1)
    const group = feed.items[0]
    expect(group?.kind).toBe('tools')

    if (group?.kind === 'tools') {
      expect(group.calls.map((entry) => entry.status)).toEqual(['running', 'error'])
    }
  })

  test('skips assistant messages that only carry tool calls', () => {
    const feed = fold([
      event(
        'agent.message',
        { turn: 1, message: { role: 'assistant', content: '', toolCalls: [] } },
        'thr_conductor',
      ),
    ])

    expect(feed.items).toHaveLength(0)
  })

  test('turns ask_user gates into answerable questions', () => {
    const pending = fold([
      event(
        'agent.tool_call.requested',
        { turn: 1, toolCall: { id: 'c1', name: 'ask_user', arguments: { title: 'Which?' } } },
        'thr_conductor',
      ),
      event('approval.requested', { approvalId: 'a1', title: 'Which?' }, 'thr_conductor'),
    ])

    expect(pending.items).toHaveLength(1)
    expect(pending.items[0]).toMatchObject({ kind: 'question', approvalId: 'a1', title: 'Which?' })
    expect(pending.items[0]).not.toHaveProperty('decision')

    const answered = sessionFeed.reduce(
      pending,
      event('approval.decided', {
        approvalId: 'a1',
        actionId: 'answer',
        outcome: 'approve',
        payload: { answer: 'The first one' },
      }),
    )

    expect(answered.items[0]).toMatchObject({ decision: { answer: 'The first one' } })
  })
})

describe('streaming text', () => {
  test('accumulates deltas until the durable message lands', () => {
    const delta = (text: string) =>
      event('agent.turn.text_delta', { turn: 1, delta: text }, 'thr_narrator')

    const streamed = [delta('Hel'), delta('lo')].reduce(
      streamingText.reduce,
      streamingText.initialState,
    )

    expect(streamed).toEqual({ thr_narrator: 'Hello' })

    const settled = streamingText.reduce(
      streamed,
      event(
        'agent.message',
        { turn: 1, message: { role: 'assistant', content: 'Hello' } },
        'thr_narrator',
      ),
    )

    expect(settled).toEqual({})
  })
})

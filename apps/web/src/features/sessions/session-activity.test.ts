import { describe, expect, test } from 'bun:test'

import { isSessionUnread } from './seen-sessions'
import {
  initialSessionActivityState,
  reduceSessionActivity,
  resolveFolderIndicator,
  resolveSessionIndicator,
  resolveThreadActivityTone,
} from './session-activity'

describe('sessionActivity reducer and thread tones', () => {
  test('distinguishes working, delegating, needs_input, error, and idle across threads', () => {
    let state = initialSessionActivityState

    state = reduceSessionActivity(state, {
      seq: 1,
      type: 'runtime.run.started',
      payload: { rootThreadId: 'thr_root' },
    })

    state = reduceSessionActivity(state, {
      seq: 2,
      type: 'runtime.thread.started',
      threadId: 'thr_root',
      payload: { threadId: 'thr_root', kind: 'shuttle-session', definitionName: 'coding' },
    })

    state = reduceSessionActivity(state, {
      seq: 3,
      type: 'shuttle.conductor.spawned',
      threadId: 'thr_root',
      payload: { childThreadId: 'thr_cond' },
    })

    state = reduceSessionActivity(state, {
      seq: 4,
      type: 'runtime.thread.started',
      threadId: 'thr_cond',
      payload: { threadId: 'thr_cond', kind: 'agent', definitionName: 'conductor' },
    })

    state = reduceSessionActivity(state, {
      seq: 5,
      type: 'runtime.wait.registered',
      threadId: 'thr_root',
      payload: { waitId: 'w_mail', tag: { kind: 'shuttle-mailbox' } },
    })

    expect(state.activity).toBe('working')

    expect(
      resolveThreadActivityTone(state, {
        threadId: 'thr_cond',
        kind: 'agent',
        status: 'running',
      }),
    ).toBe('working')

    // Conductor delegates to a worker: conductor becomes 'delegating', worker is 'working'.
    state = reduceSessionActivity(state, {
      seq: 6,
      type: 'agent.turn.started',
      threadId: 'thr_cond',
      payload: { turn: 1, messageCount: 1 },
    })

    state = reduceSessionActivity(state, {
      seq: 7,
      type: 'agent.tool_call.requested',
      threadId: 'thr_cond',
      payload: { turn: 1, toolCall: { id: 'c_del', name: 'delegate', arguments: {} } },
    })

    state = reduceSessionActivity(state, {
      seq: 8,
      type: 'agent.turn.settled',
      threadId: 'thr_cond',
      payload: { turn: 1 },
    })

    state = reduceSessionActivity(state, {
      seq: 9,
      type: 'agent.spawn.requested',
      threadId: 'thr_cond',
      payload: { toolCallId: 'c_del', childThreadId: 'thr_worker' },
    })

    state = reduceSessionActivity(state, {
      seq: 10,
      type: 'runtime.thread.started',
      threadId: 'thr_worker',
      payload: { threadId: 'thr_worker', kind: 'agent', definitionName: 'worker' },
    })

    expect(state.activity).toBe('working')

    expect(
      resolveThreadActivityTone(state, {
        threadId: 'thr_cond',
        kind: 'agent',
        status: 'waiting',
      }),
    ).toBe('delegating')

    expect(
      resolveThreadActivityTone(state, {
        threadId: 'thr_worker',
        kind: 'agent',
        status: 'running',
      }),
    ).toBe('working')

    // Worker completes and conductor settles its summary turn -> both Session and Conductor go 'idle'.
    state = reduceSessionActivity(state, {
      seq: 11,
      type: 'runtime.thread.completed',
      threadId: 'thr_worker',
      payload: { threadId: 'thr_worker', output: {} },
    })

    state = reduceSessionActivity(state, {
      seq: 12,
      type: 'agent.tool.result',
      threadId: 'thr_cond',
      payload: { turn: 1, toolCallId: 'c_del', name: 'delegate', result: {}, error: null },
    })

    state = reduceSessionActivity(state, {
      seq: 13,
      type: 'agent.turn.started',
      threadId: 'thr_cond',
      payload: { turn: 2, messageCount: 2 },
    })

    state = reduceSessionActivity(state, {
      seq: 14,
      type: 'agent.message',
      threadId: 'thr_cond',
      payload: { turn: 2, message: { role: 'assistant', content: 'Done' } },
    })

    state = reduceSessionActivity(state, {
      seq: 15,
      type: 'agent.turn.settled',
      threadId: 'thr_cond',
      payload: { turn: 2 },
    })

    expect(state.activity).toBe('idle')

    expect(
      resolveThreadActivityTone(state, {
        threadId: 'thr_root',
        kind: 'shuttle-session',
        status: 'waiting',
      }),
    ).toBe('idle')

    expect(
      resolveThreadActivityTone(state, {
        threadId: 'thr_cond',
        kind: 'agent',
        status: 'running',
      }),
    ).toBe('idle')

    expect(
      resolveThreadActivityTone(state, {
        threadId: 'thr_worker',
        kind: 'agent',
        status: 'completed',
      }),
    ).toBe('completed')
  })

  test('settles legacy turns that end at agent.message without agent.turn.settled', () => {
    let state = initialSessionActivityState

    state = reduceSessionActivity(state, {
      seq: 1,
      type: 'runtime.thread.started',
      threadId: 'thr_cond',
      payload: { threadId: 'thr_cond', kind: 'agent', definitionName: 'conductor' },
    })

    state = reduceSessionActivity(state, {
      seq: 2,
      type: 'agent.turn.started',
      threadId: 'thr_cond',
      payload: { turn: 1, messageCount: 1 },
    })

    expect(state.activity).toBe('working')

    state = reduceSessionActivity(state, {
      seq: 3,
      type: 'agent.message',
      threadId: 'thr_cond',
      payload: { turn: 1, message: { role: 'assistant', content: 'Summary complete.' } },
    })

    state = reduceSessionActivity(state, {
      seq: 4,
      type: 'agent.turn.usage',
      threadId: 'thr_cond',
      payload: { turn: 1, input: 100, output: 50 },
    })

    expect(state.activity).toBe('idle')
  })
})

describe('session and folder indicator resolution', () => {
  test('maps session status, activity, and unread completion to distinct tones', () => {
    expect(resolveSessionIndicator({ status: 'requested', activity: 'idle' })).toBe('starting')
    expect(resolveSessionIndicator({ status: 'running', activity: 'working' })).toBe('working')

    expect(resolveSessionIndicator({ status: 'running', activity: 'needs_input' })).toBe(
      'needs_input',
    )

    expect(resolveSessionIndicator({ status: 'running', activity: 'error' })).toBe('failed')
    expect(resolveSessionIndicator({ status: 'failed', activity: 'idle' })).toBe('failed')

    expect(resolveSessionIndicator({ status: 'running', activity: 'idle', unread: true })).toBe(
      'ready',
    )

    expect(resolveSessionIndicator({ status: 'running', activity: 'idle', unread: false })).toBe(
      'idle',
    )

    expect(resolveSessionIndicator({ status: 'completed', activity: 'idle' })).toBe('completed')
    expect(resolveSessionIndicator({ status: 'cancelled', activity: 'idle' })).toBe('cancelled')
  })

  test('prioritizes folder rollup by urgency and stays quiet when all sessions are idle', () => {
    expect(resolveFolderIndicator(['idle', 'completed', 'cancelled'])).toBeNull()

    expect(resolveFolderIndicator(['idle', 'ready', 'working'])).toEqual({
      tone: 'working',
      count: 1,
      label: '1 session working',
    })

    expect(resolveFolderIndicator(['working', 'failed', 'ready'])).toEqual({
      tone: 'failed',
      count: 1,
      label: '1 session failed',
    })

    expect(resolveFolderIndicator(['working', 'needs_input', 'failed', 'needs_input'])).toEqual({
      tone: 'needs_input',
      count: 2,
      label: '2 sessions need input',
    })
  })

  test('computes unread completion against baseline and active route', () => {
    const snapshot = { baselineAt: 1000, seen: { s_seen: 2500 } }

    // Pre-baseline completion is not marked unread.
    expect(isSessionUnread({ runId: 's_old', lastCompletedAt: 900 }, { snapshot })).toBe(false)

    // Post-baseline unseen completion is marked unread.
    expect(isSessionUnread({ runId: 's_new', lastCompletedAt: 1500 }, { snapshot })).toBe(true)

    // Actively open session is never unread.
    expect(
      isSessionUnread(
        { runId: 's_new', lastCompletedAt: 1500 },
        { activeRunId: 's_new', snapshot },
      ),
    ).toBe(false)

    // Already seen after completion is not unread.
    expect(isSessionUnread({ runId: 's_seen', lastCompletedAt: 2000 }, { snapshot })).toBe(false)
  })
})

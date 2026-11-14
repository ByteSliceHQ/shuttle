import { describe, expect, test } from 'bun:test'

import type { JsonValue } from '@swirls/looms/core'

import type { SessionEvent } from './event-catalog'
import { sessionFeed, streamingText, streamingTurns } from './session-feed'

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
    expect(feed.brief).toHaveLength(1)
    expect(feed.brief[0]).toMatchObject({ version: 1, text: 'Ship it' })
  })

  test('a message keeps its author, and the agent records whose subscription it ran on', () => {
    const feed = fold([
      event('shuttle.user.said', {
        messageId: 'm1',
        text: 'Add a footer',
        author: { id: 'bob', name: 'Bob' },
      }),
      event('shuttle.user.said', { messageId: 'm2', text: 'From before sign-in' }),
      event(
        'shuttle.vendor.turn_started',
        { turn: 1, harness: 'claude-code', label: 'Claude Code', billedTo: 'bob' },
        'thr_conductor',
      ),
    ])

    const said = feed.items.filter((item) => item.kind === 'user')

    expect(said.map((item) => item.author)).toEqual([{ id: 'bob', name: 'Bob' }, undefined])
    expect(feed.vendorAgents['thr_conductor']).toMatchObject({ billedTo: 'bob' })
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

  test('shows a notice when the conductor restarts', () => {
    const feed = fold([
      event('shuttle.conductor.spawned', {
        childThreadId: 'thr_conductor',
        generation: 0,
        reason: 'initial',
      }),
      event('shuttle.conductor.spawned', {
        childThreadId: 'thr_conductor_1',
        generation: 1,
        reason: 'failed',
      }),
    ])

    expect(feed.items).toHaveLength(1)

    expect(feed.items[0]).toMatchObject({
      kind: 'notice',
      text: 'Conductor restarted (generation 1) after failed.',
    })
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

  test('links published PRs to the thread that proposed them', () => {
    const feed = fold([
      event(
        'approval.requested',
        { approvalId: 'pr_publish_1', title: 'Publish pull requests? Fix login' },
        'thr_coder',
      ),
      event('approval.decided', {
        approvalId: 'pr_publish_1',
        actionId: 'publish',
        outcome: 'approve',
        payload: { title: 'Fix login', body: '', draft: false },
      }),
      event('shuttle.pr.published', {
        approvalId: 'pr_publish_1',
        threadId: 'thr_coder',
        pulls: [
          {
            fullName: 'acme/api',
            number: 7,
            url: 'https://github.com/acme/api/pull/7',
            draft: false,
          },
        ],
      }),
    ])

    const pull = {
      fullName: 'acme/api',
      number: 7,
      url: 'https://github.com/acme/api/pull/7',
      draft: false,
      threadId: 'thr_coder',
    }

    expect(feed.publishedPulls).toEqual([pull])

    expect(feed.items[0]).toMatchObject({
      kind: 'question',
      publish: { status: 'published', pulls: [pull] },
    })
  })

  test('keeps the proposed PR fields so the approval card can prefill them', () => {
    const feed = fold([
      event(
        'approval.requested',
        {
          approvalId: 'pr_publish_4',
          title: 'Publish pull requests?',
          schema: {
            type: 'object',
            properties: {
              title: { type: 'string', default: 'Add sample docs' },
              body: { type: 'string', default: '## Summary' },
              draft: { type: 'boolean', default: true },
            },
          },
        },
        'thr_coder',
      ),
    ])

    expect(feed.items[0]).toMatchObject({
      defaults: { title: 'Add sample docs', body: '## Summary', draft: true },
    })
  })

  test('stamps stack labels on the publish approval card from gate defaults', () => {
    const feed = fold([
      event(
        'approval.requested',
        {
          approvalId: 'pr_publish_5',
          title: 'Publish?',
          schema: {
            type: 'object',
            properties: {
              parentPullLabel: { type: 'string', default: 'ByteSliceHQ/glue#2' },
              restackLabel: { type: 'string', default: '#3, #4' },
              repo: { type: 'string', default: 'glue' },
              layer: { type: 'number', default: 2 },
            },
          },
        },
        'thr_coder',
      ),
    ])

    expect(feed.items[0]).toMatchObject({
      defaults: {
        parentPullLabel: 'ByteSliceHQ/glue#2',
        restackLabel: '#3, #4',
        repo: 'glue',
        layer: 2,
      },
    })
  })

  test('falls back to the approval thread for PRs published before thread links', () => {
    const feed = fold([
      event('approval.requested', { approvalId: 'pr_publish_2', title: 'Publish?' }, 'thr_coder'),
      event('shuttle.pr.published', {
        approvalId: 'pr_publish_2',
        pulls: [{ fullName: 'acme/web', number: 3, url: 'u', draft: true }],
      }),
    ])

    expect(feed.publishedPulls[0]?.threadId).toBe('thr_coder')
  })

  test('shows publish failures on the approval card', () => {
    const feed = fold([
      event('approval.requested', { approvalId: 'pr_publish_3', title: 'Publish?' }, 'thr_coder'),
      event('shuttle.pr.publish_failed', {
        approvalId: 'pr_publish_3',
        error: 'Resource not accessible by integration',
      }),
    ])

    expect(feed.items[0]).toMatchObject({
      publish: { status: 'failed', error: 'Resource not accessible by integration' },
    })

    expect(feed.publishedPulls).toEqual([])
  })
})

describe('streaming turns', () => {
  test('accumulates thinking and text until the durable message lands', () => {
    const think = (text: string) =>
      event('shuttle.turn.thinking_delta', { turn: 1, delta: text }, 'thr_narrator')

    const delta = (text: string) =>
      event('agent.turn.text_delta', { turn: 1, delta: text }, 'thr_narrator')

    const streamed = [think('Hmm'), think('…'), delta('Hel'), delta('lo')].reduce(
      streamingTurns.reduce,
      streamingTurns.initialState,
    )

    expect(streamed.thr_narrator).toMatchObject({
      turn: 1,
      thinking: 'Hmm…',
      text: 'Hello',
    })

    const settled = streamingTurns.reduce(
      streamed,
      event(
        'agent.message',
        { turn: 1, message: { role: 'assistant', content: 'Hello' } },
        'thr_narrator',
      ),
    )

    expect(settled).toEqual({})
  })

  test('clears on turn settled and keeps streamingText compatible', () => {
    const streamed = streamingTurns.reduce(
      streamingTurns.initialState,
      event('agent.turn.text_delta', { turn: 2, delta: 'Hi' }, 'thr_worker'),
    )

    expect(
      streamingText.reduce(
        {},
        event('agent.turn.text_delta', { turn: 2, delta: 'Hi' }, 'thr_worker'),
      ),
    ).toEqual({
      thr_worker: 'Hi',
    })

    expect(
      streamingTurns.reduce(streamed, event('agent.turn.settled', { turn: 2 }, 'thr_worker')),
    ).toEqual({})
  })
})

describe('thinking fold', () => {
  test('pairs a thought onto the following assistant reply', () => {
    const feed = fold([
      event(
        'shuttle.turn.thought',
        { turn: 1, text: 'I should greet the user', durationMs: 1200 },
        'thr_narrator',
      ),
      event(
        'agent.message',
        { turn: 1, message: { role: 'assistant', content: 'Hello there' } },
        'thr_narrator',
      ),
    ])

    expect(feed.items).toHaveLength(1)

    expect(feed.items[0]).toMatchObject({
      kind: 'agent',
      text: 'Hello there',
      thought: {
        text: 'I should greet the user',
        durationMs: 1200,
        turn: 1,
      },
    })
  })

  test('folds consecutive silent thoughts and tool calls into one activity card', () => {
    const feed = fold([
      event(
        'shuttle.turn.thought',
        { turn: 1, text: 'Need to inspect the file first', durationMs: 800 },
        'thr_worker',
      ),
      event(
        'agent.message',
        { turn: 1, message: { role: 'assistant', content: '', toolCalls: [] } },
        'thr_worker',
      ),
      event(
        'agent.tool_call.requested',
        { turn: 1, toolCall: { id: 'c1', name: 'read_file', arguments: { path: '/a.ts' } } },
        'thr_worker',
      ),
      event(
        'agent.tool.result',
        { turn: 1, toolCallId: 'c1', name: 'read_file', result: 'ok', error: null },
        'thr_worker',
      ),
      event('agent.turn.settled', { turn: 1 }, 'thr_worker'),
      event(
        'shuttle.turn.thought',
        { turn: 2, text: 'Now patch the import', durationMs: 1100 },
        'thr_worker',
      ),
      event(
        'agent.message',
        { turn: 2, message: { role: 'assistant', content: '', toolCalls: [] } },
        'thr_worker',
      ),
      event(
        'agent.tool_call.requested',
        { turn: 2, toolCall: { id: 'c2', name: 'edit_file', arguments: { path: '/a.ts' } } },
        'thr_worker',
      ),
    ])

    expect(feed.items).toHaveLength(1)
    const item = feed.items[0]
    expect(item?.kind).toBe('tools')

    if (item?.kind === 'tools') {
      expect(item.calls).toHaveLength(2)
      expect(item.thoughts).toHaveLength(2)
      expect(item.steps.map((step) => step.kind)).toEqual(['thought', 'call', 'thought', 'call'])

      expect(item.steps[1]).toMatchObject({
        kind: 'call',
        call: { toolCallId: 'c1', status: 'ok' },
      })
    }
  })

  test('attaches a thought onto an ask_user question card', () => {
    const feed = fold([
      event(
        'shuttle.turn.thought',
        { turn: 3, text: 'Better confirm the port with the user', durationMs: 650 },
        'thr_conductor',
      ),
      event(
        'agent.message',
        { turn: 3, message: { role: 'assistant', content: '', toolCalls: [] } },
        'thr_conductor',
      ),
      event(
        'agent.tool_call.requested',
        { turn: 3, toolCall: { id: 'q1', name: 'ask_user', arguments: { title: 'Port?' } } },
        'thr_conductor',
      ),
      event('approval.requested', { approvalId: 'a_port', title: 'Port?' }, 'thr_conductor'),
    ])

    expect(feed.items).toHaveLength(1)

    expect(feed.items[0]).toMatchObject({
      kind: 'question',
      approvalId: 'a_port',
      thought: {
        text: 'Better confirm the port with the user',
        durationMs: 650,
        turn: 3,
      },
    })
  })

  test('flushes an unclaimed thought when a turn settles with no text or tools', () => {
    const feed = fold([
      event(
        'shuttle.turn.thought',
        { turn: 4, text: 'Nothing left to do', durationMs: 300 },
        'thr_worker',
      ),
      event('agent.turn.settled', { turn: 4 }, 'thr_worker'),
    ])

    expect(feed.items).toHaveLength(1)

    expect(feed.items[0]).toMatchObject({
      kind: 'thought',
      text: 'Nothing left to do',
      durationMs: 300,
      turn: 4,
    })
  })
})

import { describe, expect, test } from 'bun:test'

import { vendorStepEvent } from './thinking-middleware'

describe('vendorStepEvent', () => {
  test('shapes tool steps like Looms tool events so the session view reuses its rendering', () => {
    expect(
      vendorStepEvent(
        {
          type: 'tool_started',
          toolCall: { id: 't1', name: 'bash', arguments: { command: 'ls' } },
        },
        3,
        'thr',
      ),
    ).toEqual({
      type: 'shuttle.vendor.tool_started',
      payload: { turn: 3, toolCall: { id: 't1', name: 'bash', arguments: { command: 'ls' } } },
      threadId: 'thr',
    })

    expect(
      vendorStepEvent({ type: 'tool_finished', toolCallId: 't1', result: 'a.ts' }, 3, 'thr'),
    ).toEqual({
      type: 'shuttle.vendor.tool_finished',
      payload: { turn: 3, toolCallId: 't1', result: 'a.ts' },
      threadId: 'thr',
    })
  })

  test('maps the other steps onto their events', () => {
    expect(
      vendorStepEvent({ type: 'started', harness: 'codex', label: 'Codex', model: 'm' }, 1, 'thr'),
    ).toMatchObject({
      type: 'shuttle.vendor.turn_started',
      payload: { turn: 1, harness: 'codex', label: 'Codex', model: 'm' },
    })

    expect(vendorStepEvent({ type: 'message', text: 'hi' }, 1, 'thr')).toMatchObject({
      type: 'shuttle.vendor.message',
      payload: { turn: 1, text: 'hi' },
    })

    expect(vendorStepEvent({ type: 'thought', text: 'hm', durationMs: 5 }, 1, 'thr')).toMatchObject(
      { type: 'shuttle.turn.thought', payload: { turn: 1, text: 'hm', durationMs: 5 } },
    )
  })
})

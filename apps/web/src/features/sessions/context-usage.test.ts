import { describe, expect, test } from 'bun:test'

import type { SessionEvent } from '@/features/events/event-catalog'
import type { JsonValue } from '@swirls/looms/core'

import {
  buildContextUsageReport,
  contextUsage,
  estimateTokens,
  formatTokenCount,
  formatTokenTotal,
  type ContextUsageState,
} from './context-usage'
import { sessionFeed, type SessionFeed } from './session-feed'

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

function foldUsage(events: readonly SessionEvent[]): ContextUsageState {
  return events.reduce(contextUsage.reduce, contextUsage.initialState)
}

function foldFeed(events: readonly SessionEvent[]): SessionFeed {
  return events.reduce(sessionFeed.reduce, sessionFeed.initialState)
}

describe('context usage projection', () => {
  test('tracks last turn and cumulative totals from agent.turn.usage', () => {
    const usage = foldUsage([
      event('agent.turn.usage', { turn: 1, input: 1_200, output: 80 }, 'thr_a'),
      event('agent.turn.usage', { turn: 2, input: 3_400, output: 120 }, 'thr_b'),
      event('shuttle.user.said', { messageId: 'm1', text: 'hi' }),
    ])

    expect(usage.lastTurn).toMatchObject({
      threadId: 'thr_b',
      turn: 2,
      input: 3_400,
      output: 120,
    })

    expect(usage.totals).toEqual({ input: 4_600, output: 200 })
  })
})

describe('formatTokenCount', () => {
  test('formats compact counts like the Cursor meter', () => {
    expect(formatTokenCount(546)).toBe('546')
    expect(formatTokenCount(2_900)).toBe('2.9K')
    expect(formatTokenCount(9_000)).toBe('9K')
    expect(formatTokenCount(255_400)).toBe('255.4K')
    expect(formatTokenTotal(300_000)).toBe('300K')
    expect(formatTokenTotal(1_000_000)).toBe('1M')
  })
})

describe('buildContextUsageReport', () => {
  test('uses billed last-turn input and attributes remainder to system & tools', () => {
    const feed = foldFeed([
      event('runtime.thread.started', { input: { goal: 'Ship dark mode' } }),
      event('shuttle.user.said', { messageId: 'm1', text: 'Prefer CSS variables' }),
      event('shuttle.playbook.loaded', {
        version: 1,
        lessons: [{ id: 'l1', text: 'Always run tests before claiming done' }],
      }),
    ])

    const usage = foldUsage([event('agent.turn.usage', { turn: 1, input: 10_000, output: 200 })])

    const report = buildContextUsageReport(usage, feed, 100_000)

    expect(report.estimated).toBe(false)
    expect(report.used).toBe(10_000)
    expect(report.percent).toBe(10)

    expect(
      report.segments.find((segment) => segment.id === 'conversation')?.tokens,
    ).toBeGreaterThan(0)

    expect(report.segments.find((segment) => segment.id === 'other')?.tokens).toBeGreaterThan(0)

    const attributed = report.segments.reduce((sum, segment) => sum + segment.tokens, 0)
    expect(attributed).toBe(10_000)
  })

  test('falls back to feed estimates when billed input is zero', () => {
    const text = 'x'.repeat(400)

    const feed = foldFeed([event('runtime.thread.started', { input: { goal: text } })])

    const usage = foldUsage([event('agent.turn.usage', { turn: 1, input: 0, output: 50 })])

    const report = buildContextUsageReport(usage, feed, 200_000)

    expect(report.estimated).toBe(true)
    expect(report.used).toBe(estimateTokens(text))
    expect(report.segments.some((segment) => segment.id === 'brief')).toBe(true)
  })
})

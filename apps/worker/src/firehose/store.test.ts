import { describe, expect, test } from 'bun:test'

import type { EventEnvelope } from '@swirls/looms/core'

import { createMemoryFirehoseSql } from './memory-sql'
import {
  ensureFirehoseSchema,
  eventCount,
  ingest,
  latestCursor,
  matchesFirehoseFilter,
  pruneFirehose,
  readAfter,
  readBefore,
} from './store'

function envelope(
  overrides: Partial<EventEnvelope> & Pick<EventEnvelope, 'seq' | 'type'>,
): EventEnvelope {
  return {
    id: overrides.id ?? `evt_${overrides.seq}`,
    runId: overrides.runId ?? 'session_a',
    seq: overrides.seq,
    ts: overrides.ts ?? Date.now(),
    type: overrides.type,
    payload: overrides.payload ?? {},
    threadId: overrides.threadId ?? 'thr_1',
    origin: overrides.origin ?? { type: 'system' },
    ephemeral: overrides.ephemeral,
  }
}

function openStore() {
  const sql = createMemoryFirehoseSql()
  ensureFirehoseSchema(sql)
  return sql
}

describe('firehose store', () => {
  test('ingests events with global cursors across runs and dedupes redelivery', () => {
    const sql = openStore()
    const now = 1_700_000_000_000

    const first = ingest(
      sql,
      'session_a',
      'session',
      [envelope({ seq: 1, type: 'agent.turn.started', ts: now, runId: 'session_a' })],
      now,
    )

    const second = ingest(
      sql,
      'session_b',
      'session',
      [envelope({ seq: 1, type: 'runtime.run.started', ts: now + 1, runId: 'session_b' })],
      now,
    )

    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(first[0]?.cursor).toBe(1)
    expect(second[0]?.cursor).toBe(2)
    expect(latestCursor(sql)).toBe(2)

    const redelivered = ingest(
      sql,
      'session_a',
      'session',
      [envelope({ seq: 1, type: 'agent.turn.started', ts: now, runId: 'session_a' })],
      now,
    )

    expect(redelivered).toHaveLength(0)
    expect(eventCount(sql)).toBe(2)
    expect(latestCursor(sql)).toBe(2)
  })

  test('skips ephemeral and stale envelopes', () => {
    const sql = openStore()
    const now = 1_700_000_000_000

    const frames = ingest(
      sql,
      'session_a',
      'session',
      [
        envelope({
          seq: 1,
          type: 'agent.turn.text_delta',
          ts: now,
          ephemeral: true,
          runId: 'session_a',
        }),
        envelope({
          seq: 2,
          type: 'agent.message',
          ts: now - 25 * 60 * 60 * 1000,
          runId: 'session_a',
        }),
        envelope({ seq: 3, type: 'agent.message', ts: now, runId: 'session_a' }),
      ],
      now,
    )

    expect(frames).toHaveLength(1)
    expect(frames[0]?.event.seq).toBe(3)
    expect(eventCount(sql)).toBe(1)
  })

  test('readAfter and readBefore respect filters and ordering', () => {
    const sql = openStore()
    const now = 1_700_000_000_000

    ingest(
      sql,
      'session_a',
      'session',
      [
        envelope({ seq: 1, type: 'agent.turn.started', ts: now, runId: 'session_a' }),
        envelope({ seq: 2, type: 'runtime.effect.completed', ts: now + 1, runId: 'session_a' }),
      ],
      now,
    )

    ingest(
      sql,
      'shuttle-workspace',
      'workspace',
      [
        envelope({
          seq: 1,
          type: 'workspace.session.requested',
          ts: now + 2,
          runId: 'shuttle-workspace',
        }),
      ],
      now,
    )

    const after = readAfter(sql, 0, 10, { runKinds: ['session'] })
    expect(after.map((frame) => frame.cursor)).toEqual([1, 2])

    const family = readAfter(sql, 0, 10, { families: ['agent'] })
    expect(family).toHaveLength(1)
    expect(family[0]?.event.type).toBe('agent.turn.started')

    const before = readBefore(sql, 3, 2)
    expect(before.map((frame) => frame.cursor)).toEqual([1, 2])
  })

  test('prunes by age and max count', () => {
    const sql = openStore()
    const now = 1_700_000_000_000

    for (let seq = 1; seq <= 5; seq++) {
      ingest(
        sql,
        'session_a',
        'session',
        [envelope({ seq, type: 'agent.message', ts: now - (6 - seq) * 1000, runId: 'session_a' })],
        now,
      )
    }

    expect(eventCount(sql)).toBe(5)

    const ageDeleted = pruneFirehose(sql, now, 50_000, 2500)
    expect(ageDeleted).toBeGreaterThan(0)
    expect(eventCount(sql)).toBeLessThan(5)

    for (let seq = 10; seq <= 20; seq++) {
      ingest(
        sql,
        'session_a',
        'session',
        [envelope({ seq, type: 'agent.message', ts: now, runId: 'session_a' })],
        now,
      )
    }

    const beforeCount = eventCount(sql)
    const countDeleted = pruneFirehose(sql, now, 5, 24 * 60 * 60 * 1000)
    expect(countDeleted).toBe(beforeCount - 5)
    expect(eventCount(sql)).toBe(5)
  })

  test('matchesFirehoseFilter checks kind, run, and family', () => {
    const row = { runId: 'session_a', runKind: 'session' as const, type: 'agent.message' }

    expect(matchesFirehoseFilter(row, {})).toBe(true)
    expect(matchesFirehoseFilter(row, { runKinds: ['workspace'] })).toBe(false)
    expect(matchesFirehoseFilter(row, { runIds: ['session_b'] })).toBe(false)
    expect(matchesFirehoseFilter(row, { families: ['effect'] })).toBe(false)
    expect(matchesFirehoseFilter(row, { families: ['agent'], runKinds: ['session'] })).toBe(true)
  })
})

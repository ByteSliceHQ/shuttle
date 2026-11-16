import { describe, expect, test } from 'bun:test'

import { readClientTiming } from './timings'

describe('readClientTiming', () => {
  test('keeps the fields a timing carries and rounds its numbers', () => {
    expect(
      readClientTiming({
        type: 'store.synced',
        runId: 'run_1',
        durationMs: 412.6,
        eventCount: 90,
        cachedEvents: 80,
      }),
    ).toEqual({
      type: 'store.synced',
      runId: 'run_1',
      durationMs: 413,
      eventCount: 90,
      cachedEvents: 80,
    })
  })

  test('drops unknown types, unknown fields and values of the wrong kind', () => {
    expect(readClientTiming({ type: 'anything.else', durationMs: 1 })).toBeNull()
    expect(readClientTiming('store.synced')).toBeNull()

    expect(
      readClientTiming({
        type: 'commit.acked',
        durationMs: -5,
        eventCount: 'many',
        optimistic: true,
        password: 'hunter2',
      }),
    ).toEqual({ type: 'commit.acked', optimistic: true })
  })

  test('cuts long text short', () => {
    const timing = readClientTiming({ type: 'commit.failed', message: 'x'.repeat(5_000) })

    expect(String(timing?.message)).toHaveLength(200)
  })
})

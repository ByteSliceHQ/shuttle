import { describe, expect, test } from 'bun:test'

import { friction } from './friction'

describe('friction projection', () => {
  test('records interrupting steers as corrections', () => {
    const next = friction.reduce(friction.initialState, {
      id: 'e1',
      runId: 'run_1',
      seq: 4,
      ts: 1,
      type: 'agent.steered',
      payload: {
        turn: 1,
        interrupt: true,
        message: { role: 'user', content: 'Do not touch the lockfile' },
      },
      origin: { type: 'external' },
      threadId: 'worker_1',
    })

    expect(next.entries).toHaveLength(1)
    expect(next.entries[0]?.kind).toBe('correction')
    expect(next.entries[0]?.summary).toContain('lockfile')
  })
})

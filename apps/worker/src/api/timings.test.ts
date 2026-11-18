import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test'

import type { Actor } from '../tenancy/access'
import { fakeEnv } from '../testing/fake-env'
import { handleApi } from './handler'

const actor: Actor = {
  userId: 'user1',
  orgId: 'org1',
  role: 'member',
  name: 'Ada',
  email: 'ada@example.com',
}

let log: Mock<typeof console.log>

beforeEach(() => {
  log = spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  log.mockRestore()
})

/** Reports `timings` the way the browser does, and returns the lines the Worker logged. */
async function report(body: unknown): Promise<{ status: number; lines: unknown[] }> {
  const response = await handleApi({
    env: fakeEnv(),
    actor,
    request: new Request('https://worker.example.com/timings', {
      method: 'POST',
      // What `fetch` with `keepalive` sends from `apps/web/src/lib/timing.ts`.
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  })

  return {
    status: response?.status ?? 0,
    lines: log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown),
  }
}

const who = { kind: 'shuttle.timing', source: 'client', orgId: 'org1', userId: 'user1' }

describe('POST /timings', () => {
  test('keeps the fields a timing carries and rounds its numbers', async () => {
    const { status, lines } = await report({
      timings: [
        {
          type: 'store.synced',
          runId: 'run_1',
          durationMs: 412.6,
          eventCount: 90,
          cachedEvents: 80,
        },
      ],
    })

    expect(status).toBe(204)

    expect(lines).toEqual([
      {
        ...who,
        type: 'store.synced',
        runId: 'run_1',
        durationMs: 413,
        eventCount: 90,
        cachedEvents: 80,
      },
    ])
  })

  test('drops unknown types, unknown fields and values of the wrong kind', async () => {
    const { status, lines } = await report({
      timings: [
        { type: 'anything.else', durationMs: 1 },
        {
          type: 'commit.acked',
          durationMs: -5,
          eventCount: 'many',
          optimistic: true,
          password: 'hunter2',
        },
      ],
    })

    expect(status).toBe(204)
    expect(lines).toEqual([{ ...who, type: 'commit.acked', optimistic: true }])
  })

  test('cuts long text short', async () => {
    const { lines } = await report({
      timings: [{ type: 'commit.failed', message: 'x'.repeat(5_000) }],
    })

    expect(lines).toEqual([{ ...who, type: 'commit.failed', message: 'x'.repeat(200) }])
  })

  test('takes no more than fifty timings from one report', async () => {
    const { status, lines } = await report({
      timings: Array.from({ length: 80 }, () => ({ type: 'route.resolved', durationMs: 1 })),
    })

    expect(status).toBe(204)
    expect(lines).toHaveLength(50)
  })

  test('a report with no timings records nothing', async () => {
    expect(await report({})).toEqual({ status: 204, lines: [] })
  })

  test('a timing that is not an object refuses the report', async () => {
    expect((await report({ timings: ['store.synced'] })).status).toBe(400)
  })
})

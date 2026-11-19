import { describe, expect, test } from 'bun:test'

import { DaytonaConflictError } from '@daytona/sdk'

import {
  ensureStarted,
  isDaytonaOwnError,
  sandboxNotRunning,
  type StartableSandbox,
} from './daytona'
import { failureOf } from './test-failure'

/** A sandbox that moves through `states` each time it is looked at, and records what is asked. */
function sandboxIn(states: readonly string[], startFailures = 0) {
  const calls: string[] = []
  let at = -1
  let failures = startFailures

  const sandbox: StartableSandbox & { state: string } = {
    state: 'unknown',
    refreshData: async () => {
      at = Math.min(at + 1, states.length - 1)
      sandbox.state = states[at] ?? 'unknown'
    },
    start: async () => {
      calls.push('start')

      if (failures > 0) {
        failures -= 1
        throw new DaytonaConflictError('Sandbox state change in progress')
      }

      sandbox.state = 'started'
    },
    waitUntilStarted: async () => {
      calls.push('waitUntilStarted')
      sandbox.state = 'started'
    },
    waitUntilStopped: async () => {
      calls.push('waitUntilStopped')
      sandbox.state = 'stopped'
    },
  }

  return { sandbox, calls }
}

const quick = { pauseMs: 0 }

describe('ensureStarted', () => {
  test('a running sandbox is left alone', async () => {
    const { sandbox, calls } = sandboxIn(['started'])

    await ensureStarted(sandbox, quick)

    expect(calls).toEqual([])
  })

  test('a stopped or archived sandbox is started', async () => {
    for (const state of ['stopped', 'archived']) {
      const { sandbox, calls } = sandboxIn([state])

      await ensureStarted(sandbox, quick)

      expect(calls).toEqual(['start'])
    }
  })

  test('a sandbox still going to sleep is waited for, then started', async () => {
    const { sandbox, calls } = sandboxIn(['stopping'])

    await ensureStarted(sandbox, quick)

    expect(calls).toEqual(['waitUntilStopped', 'start'])
  })

  test('a sandbox someone else is starting is waited for, not started again', async () => {
    const { sandbox, calls } = sandboxIn(['starting'])

    await ensureStarted(sandbox, quick)

    expect(calls).toEqual(['waitUntilStarted'])
  })

  test('a start refused because the state is changing is tried again from the new state', async () => {
    // Stopped when checked; another request starts it first, so ours is refused.
    const { sandbox, calls } = sandboxIn(['stopped', 'starting'], 1)

    await ensureStarted(sandbox, quick)

    expect(calls).toEqual(['start', 'waitUntilStarted'])
  })

  test('any other failure, and a refusal past the deadline, is reported', async () => {
    const broken = sandboxIn(['stopped'])

    broken.sandbox.start = async () => {
      throw new Error('no capacity')
    }

    expect(await failureOf(ensureStarted(broken.sandbox, quick))).toContain('no capacity')

    const stuck = sandboxIn(['stopped'], 99)

    expect(
      await failureOf(ensureStarted(stuck.sandbox, { pauseMs: 0, timeoutSeconds: 0 })),
    ).toContain('state change in progress')
  })
})

describe('sandboxNotRunning', () => {
  test("recognizes Daytona's answers for a sandbox that is asleep or changing state", () => {
    const asleep =
      'bad request: failed to resolve container IP after 3 attempts: no IP address found. Is the Sandbox started?'

    const changing = new DaytonaConflictError('Sandbox state change in progress')

    expect(sandboxNotRunning(new Error(asleep))).toBe(true)
    expect(sandboxNotRunning(`{"statusCode":400,"message":"${asleep}"}`)).toBe(true)
    expect(sandboxNotRunning(changing)).toBe(true)
  })

  test('does not mistake other failures for it', () => {
    expect(sandboxNotRunning(new Error('exit 1'))).toBe(false)
    expect(sandboxNotRunning('{"statusCode":502,"message":"proxy upstream error"}')).toBe(false)
    expect(sandboxNotRunning(undefined)).toBe(false)
  })
})

describe('isDaytonaOwnError', () => {
  const json = { 'content-type': 'application/json' }

  test("recognizes Daytona's answer for a port nothing listens on", async () => {
    const response = new Response(
      '{"statusCode":502,"message":"proxy upstream error","source":"DAYTONA_DAEMON","path":"/","method":"GET"}',
      { status: 502, headers: json },
    )

    expect(await isDaytonaOwnError(response)).toBe(true)
    // The body is still there for whoever sends the response on.
    expect(await response.text()).toContain('proxy upstream error')
  })

  test("leaves the sandbox's own answers alone", async () => {
    expect(
      await isDaytonaOwnError(
        new Response('{"error":"bad gateway"}', { status: 502, headers: json }),
      ),
    ).toBe(false)

    expect(
      await isDaytonaOwnError(new Response('{"source":"DAYTONA_DAEMON"}', { headers: json })),
    ).toBe(false)

    expect(await isDaytonaOwnError(new Response('<h1>Bad gateway</h1>', { status: 502 }))).toBe(
      false,
    )

    expect(await isDaytonaOwnError(new Response('{not json', { status: 500, headers: json }))).toBe(
      false,
    )
  })
})

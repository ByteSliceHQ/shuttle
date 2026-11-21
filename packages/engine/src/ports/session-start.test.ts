import { describe, expect, test } from 'bun:test'

import {
  admitSessionStart,
  openSessionStart,
  SessionStartRefusedError,
  type SessionStartPort,
} from './session-start'

/** What a call rejects with; fails the test when the call succeeds. */
async function rejection(call: Promise<unknown>): Promise<Error> {
  try {
    await call
  } catch (error) {
    if (error instanceof Error) {
      return error
    }

    throw error
  }

  throw new Error('expected the call to fail')
}

const request = { kind: 'host', orgId: 'org1', acting: null, repos: ['a/b'] } as const

describe('admitSessionStart', () => {
  test('standalone allows every start', async () => {
    await admitSessionStart(openSessionStart, request)
  })

  test('a refusal stops the start and says why', async () => {
    const full: SessionStartPort = {
      admit: async () => ({ allowed: false, reason: 'out of session hours' }),
    }

    const error = await rejection(admitSessionStart(full, request))

    expect(error).toBeInstanceOf(SessionStartRefusedError)
    expect(error).toMatchObject({ reason: 'out of session hours' })
  })
})

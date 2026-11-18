import { describe, expect, test } from 'bun:test'

import { DeviceId } from '@shuttle/api'
import { DEVICE_ID } from '@shuttle/runner-protocol'

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

/** A database that only records what was bound to the statements run on it. */
function recordingDb(): { db: D1Database; bound: unknown[][] } {
  const bound: unknown[][] = []

  const db = {
    prepare: () => ({
      bind: (...values: unknown[]) => {
        bound.push(values)

        return { run: async () => ({ meta: { changes: 1 } }) }
      },
    }),
  }

  // Only `prepare` is reached by the routes under test.
  return { db: db as unknown as D1Database, bound }
}

function call(path: string, init: RequestInit, env = fakeEnv()): Promise<Response | null> {
  return handleApi({
    env,
    actor,
    request: new Request(`https://worker.example.com${path}`, init),
  })
}

function register(body: unknown, env = fakeEnv()): Promise<Response | null> {
  return call(
    '/runners',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  )
}

describe('a person’s machines', () => {
  test('a device id is what the runner protocol says one is', () => {
    for (const id of ['abc123', 'a'.repeat(64), 'short', 'a'.repeat(65), 'has space', 'ok_id-9']) {
      expect(DeviceId.safeParse(id).success).toBe(DEVICE_ID.test(id))
    }
  })

  test('registering a machine answers with its token, as the desktop app sends it', async () => {
    const { db, bound } = recordingDb()

    const response = await register(
      { deviceId: 'device-123', name: '  Ada’s laptop ', platform: 'darwin' },
      fakeEnv({ AUTH_DB: db }),
    )

    expect(response?.status).toBe(200)

    const body: { token?: unknown } = (await response?.json()) ?? {}

    expect(String(body.token)).toStartWith('shr_')
    expect(bound[0]?.slice(0, 5)).toEqual(['org1', 'user1', 'device-123', 'Ada’s laptop', 'darwin'])
  })

  test('a machine registered without a name or platform still gets both', async () => {
    const { db, bound } = recordingDb()

    await register({ deviceId: 'device-123', name: '   ' }, fakeEnv({ AUTH_DB: db }))

    expect(bound[0]?.slice(3, 5)).toEqual(['This machine', 'unknown'])
  })

  test('a device id of the wrong shape is refused', async () => {
    const { db } = recordingDb()
    const env = fakeEnv({ AUTH_DB: db })

    for (const response of [
      await register({ deviceId: 'no' }, env),
      await register({ name: 'No id at all' }, env),
      await call('/runners/no', { method: 'GET' }, env),
      await call('/runners/no', { method: 'DELETE' }, env),
    ]) {
      expect(response?.status).toBe(400)
    }
  })

  test('without the database that holds machines, every route says so', async () => {
    for (const response of [
      await call('/runners', { method: 'GET' }),
      await register({ deviceId: 'device-123' }),
      await call('/runners/device-123', { method: 'GET' }),
      await call('/runners/device-123', { method: 'DELETE' }),
    ]) {
      expect(response?.status).toBe(503)
      expect(await response?.json()).toMatchObject({ error: 'Local sandboxes are unavailable' })
    }
  })
})

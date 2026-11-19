import { describe, expect, test } from 'bun:test'

import { z } from 'zod'

import { DeviceId } from '@shuttle/api'
import type { Actor } from '@shuttle/engine/tenancy/access'
import { DEVICE_ID } from '@shuttle/runner-protocol'
import type { JsonValue } from '@swirls/looms/core'

import { listDevices } from '../tenancy/devices'
import { migratedD1 } from '../testing/fake-d1'
import { fakeEnv } from '../testing/fake-env'
import { handleApi } from './handler'

const actor: Actor = {
  userId: 'user1',
  orgId: 'org1',
  role: 'member',
  name: 'Ada',
  email: 'ada@example.com',
}

function call(path: string, init: RequestInit, env = fakeEnv()): Promise<Response | null> {
  return handleApi({
    env,
    actor,
    request: new Request(`https://worker.example.com${path}`, init),
  })
}

function register(body: JsonValue, env = fakeEnv()): Promise<Response | null> {
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
    const db = await migratedD1()

    const response = await register(
      { deviceId: 'device-123', name: '  Ada’s laptop ', platform: 'darwin' },
      fakeEnv({ AUTH_DB: db }),
    )

    expect(response?.status).toBe(200)

    const body = z.object({ token: z.string() }).parse(await response?.json())

    expect(body.token).toStartWith('shr_')

    expect(await listDevices(db, 'org1', 'user1')).toMatchObject([
      { deviceId: 'device-123', name: 'Ada’s laptop', platform: 'darwin' },
    ])
  })

  test('a machine registered without a name or platform still gets both', async () => {
    const db = await migratedD1()

    await register({ deviceId: 'device-123', name: '   ' }, fakeEnv({ AUTH_DB: db }))

    expect(await listDevices(db, 'org1', 'user1')).toMatchObject([
      { name: 'This machine', platform: 'unknown' },
    ])
  })

  test('a device id of the wrong shape is refused', async () => {
    const db = await migratedD1()
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

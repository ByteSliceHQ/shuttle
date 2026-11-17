import { describe, expect, test } from 'bun:test'

import type { Actor } from '../tenancy/access'
import { fakeEnv } from '../testing/fake-env'
import { handleApi } from './handler'

const actor: Actor = {
  userId: 'user1',
  orgId: 'org1',
  role: 'admin',
  name: 'Ada',
  email: 'ada@example.com',
}

function call(path: string, init?: RequestInit): Promise<Response | null> {
  return handleApi({
    env: fakeEnv(),
    actor,
    request: new Request(`https://worker.example.com${path}`, init),
  })
}

function post(path: string, body: unknown): Promise<Response | null> {
  return call(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('handleApi', () => {
  test('answers a route in the contract with what its handler returns', async () => {
    const response = await call('/me')

    expect(response?.status).toBe(200)

    expect(await response?.json()).toEqual({
      user: { id: 'user1', name: 'Ada', email: 'ada@example.com' },
      org: { id: 'org1', role: 'admin' },
      runs: {
        workspace: expect.stringContaining('org1'),
        personal: expect.stringContaining('user1'),
        pulls: expect.stringContaining('org1'),
        playbook: expect.stringContaining('org1'),
      },
    })
  })

  test('leaves a path that is not in the contract to the other handlers', async () => {
    expect(await call('/nothing/here')).toBeNull()
    // The path is in the contract, but not with this method.
    expect(await call('/me', { method: 'DELETE' })).toBeNull()
  })

  test('an error a handler throws becomes its status, with the reason as `error` and `message`', async () => {
    // Without the database that holds machines, the route refuses with a 503.
    const response = await call('/runners')

    expect(response?.status).toBe(503)

    expect(await response?.json()).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      error: 'Local sandboxes are unavailable',
      message: 'Local sandboxes are unavailable',
    })
  })

  test('input the contract does not accept is refused with a 400', async () => {
    const response = await post('/runners', { name: 'A machine with no device id' })

    expect(response?.status).toBe(400)

    const body: { error?: unknown; message?: unknown } = (await response?.json()) ?? {}

    expect(typeof body.error).toBe('string')
    expect(body.error).toBe(body.message)
  })
})

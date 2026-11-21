import { describe, expect, test } from 'bun:test'

import { z } from 'zod'

import type { Actor } from '@shuttle/engine/tenancy/access'
import type { JsonValue } from '@swirls/looms/core'

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

function post(path: string, body: JsonValue): Promise<Response | null> {
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

    const body = z
      .strictObject({
        user: z.strictObject({ id: z.string(), name: z.string(), email: z.string() }),
        org: z.strictObject({ id: z.string(), role: z.string() }),
        runs: z.strictObject({
          workspace: z.string(),
          personal: z.string(),
          pulls: z.string(),
          playbook: z.string(),
        }),
      })
      .parse(await response?.json())

    expect(body.user).toEqual({ id: 'user1', name: 'Ada', email: 'ada@example.com' })
    expect(body.org).toEqual({ id: 'org1', role: 'admin' })
    expect(body.runs.workspace).toContain('org1')
    expect(body.runs.personal).toContain('user1')
    expect(body.runs.pulls).toContain('org1')
    expect(body.runs.playbook).toContain('org1')
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

    const body = z.object({ error: z.string(), message: z.string() }).parse(await response?.json())

    expect(body.error).toBe(body.message)
  })
})

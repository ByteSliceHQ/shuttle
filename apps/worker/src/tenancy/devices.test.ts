import { describe, expect, test } from 'bun:test'

import { migratedD1 } from '../testing/fake-d1'
import { bearerToken, deviceOfToken, listDevices, registerDevice, removeDevice } from './devices'

const laptop = {
  orgId: 'orgA',
  userId: 'alice',
  deviceId: 'laptop-1',
  name: 'Laptop',
  platform: 'darwin',
}

const request = (authorization?: string) =>
  new Request('https://shuttle.example', authorization ? { headers: { authorization } } : {})

describe('machines', () => {
  test('a registered machine has a token that leads back to it, and to nothing else', async () => {
    const db = await migratedD1()
    const { token } = await registerDevice(db, laptop, 5)

    expect(await deviceOfToken(db, token)).toEqual({ ...laptop, createdAt: 5 })
    expect(await deviceOfToken(db, `${token}0`)).toBeNull()
    expect(await deviceOfToken(db, 'not-a-token')).toBeNull()
  })

  test('registering a machine again replaces its token', async () => {
    const db = await migratedD1()
    const first = await registerDevice(db, laptop)
    const second = await registerDevice(db, { ...laptop, name: 'Renamed' })

    expect(await deviceOfToken(db, first.token)).toBeNull()
    expect((await deviceOfToken(db, second.token))?.name).toBe('Renamed')
    expect(await listDevices(db, 'orgA', 'alice')).toHaveLength(1)
  })

  test("a person sees their own machines in an organization, and no one else's", async () => {
    const db = await migratedD1()

    await registerDevice(db, laptop, 1)
    await registerDevice(db, { ...laptop, deviceId: 'desktop-1', name: 'Desktop' }, 2)
    await registerDevice(db, { ...laptop, userId: 'bob' }, 3)
    await registerDevice(db, { ...laptop, orgId: 'orgB' }, 4)

    expect((await listDevices(db, 'orgA', 'alice')).map((device) => device.name)).toEqual([
      'Laptop',
      'Desktop',
    ])
  })

  test('removing a machine ends its token', async () => {
    const db = await migratedD1()
    const { token } = await registerDevice(db, laptop)

    expect(await removeDevice(db, 'orgA', 'alice', 'laptop-1')).toBe(true)
    expect(await deviceOfToken(db, token)).toBeNull()
    expect(await removeDevice(db, 'orgA', 'alice', 'laptop-1')).toBe(false)
  })

  test('reads a bearer token from a request', () => {
    expect(bearerToken(request('Bearer shr_abc'))).toBe('shr_abc')
    expect(bearerToken(request('Basic abc'))).toBeNull()
    expect(bearerToken(request())).toBeNull()
  })
})

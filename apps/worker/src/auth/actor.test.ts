import { describe, expect, test } from 'bun:test'

import { isOrgId } from '@shuttle/api'

import { signUp, testAuth, TEST_WEB_ORIGIN } from '../testing/auth'
import { orgRole, resolveActor } from './actor'

function request(headers?: Headers): Request {
  return new Request(`${TEST_WEB_ORIGIN}/workspace`, { headers })
}

describe('resolveActor', () => {
  test('a request without a sign-in has no actor', async () => {
    const { auth } = await testAuth()

    expect(await resolveActor(auth, request())).toBeNull()
  })

  test('a new account gets a personal organization and owns it', async () => {
    const { auth } = await testAuth()
    const alice = await signUp(auth, 'Alice')

    const actor = await resolveActor(auth, request(alice))

    expect(actor).toMatchObject({ name: 'Alice', email: 'alice@example.com', role: 'owner' })
    // Run ids embed the organization id, so it has to fit their format.
    expect(isOrgId(actor?.orgId)).toBe(true)

    // The organization is chosen once and kept.
    expect((await resolveActor(auth, request(alice)))?.orgId).toBe(actor?.orgId)
  })

  test('two accounts never share an organization by default', async () => {
    const { auth } = await testAuth()
    const alice = await resolveActor(auth, request(await signUp(auth, 'Alice')))
    const bob = await resolveActor(auth, request(await signUp(auth, 'Bob')))

    expect(alice?.orgId).not.toBe(bob?.orgId)
    expect(alice?.userId).not.toBe(bob?.userId)
  })

  test('a member added to an organization acts in it with their role', async () => {
    const { auth } = await testAuth()
    const aliceHeaders = await signUp(auth, 'Alice')
    const bobHeaders = await signUp(auth, 'Bob')
    const alice = await resolveActor(auth, request(aliceHeaders))
    const bob = await resolveActor(auth, request(bobHeaders))

    await auth.api.addMember({
      body: { userId: bob?.userId ?? '', organizationId: alice?.orgId ?? '', role: 'member' },
    })

    await auth.api.setActiveOrganization({
      body: { organizationId: alice?.orgId ?? '' },
      headers: bobHeaders,
    })

    expect(await resolveActor(auth, request(bobHeaders))).toMatchObject({
      userId: bob?.userId,
      orgId: alice?.orgId,
      role: 'member',
    })
  })
})

describe('orgRole', () => {
  test('the strongest of several roles counts', () => {
    expect(orgRole('member')).toBe('member')
    expect(orgRole('member,admin')).toBe('admin')
    expect(orgRole('admin, owner')).toBe('owner')
    expect(orgRole('something-else')).toBe('member')
  })
})

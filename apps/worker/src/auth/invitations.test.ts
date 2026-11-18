import { expect, test } from 'bun:test'

import { signUp, testAuth, TEST_WEB_ORIGIN } from '../testing/auth'
import { resolveActor } from './actor'

const request = (headers: Headers) => new Request(`${TEST_WEB_ORIGIN}/workspace`, { headers })

test('an invited person joins the organization by accepting the invitation', async () => {
  const { auth } = await testAuth()
  const aliceHeaders = await signUp(auth, 'Alice')
  const bobHeaders = await signUp(auth, 'Bob')
  const alice = await resolveActor(auth, request(aliceHeaders))
  const bobBefore = await resolveActor(auth, request(bobHeaders))

  // No email is sent: the inviter passes the invitation link along themselves.
  const invitation = await auth.api.createInvitation({
    body: { email: 'bob@example.com', role: 'member' },
    headers: aliceHeaders,
  })

  await auth.api.acceptInvitation({ body: { invitationId: invitation.id }, headers: bobHeaders })

  const bob = await resolveActor(auth, request(bobHeaders))

  expect(bobBefore?.orgId).not.toBe(alice?.orgId)
  expect(bob).toMatchObject({ orgId: alice?.orgId, role: 'member' })

  const { members } = await auth.api.listMembers({
    headers: aliceHeaders,
    query: { organizationId: alice?.orgId ?? '' },
  })

  expect(members.map((member) => member.userId).toSorted()).toEqual(
    [alice?.userId ?? '', bob?.userId ?? ''].toSorted(),
  )
})

test('an invitation for someone else cannot be accepted', async () => {
  const { auth } = await testAuth()
  const aliceHeaders = await signUp(auth, 'Alice')
  const malloryHeaders = await signUp(auth, 'Mallory')
  await resolveActor(auth, request(aliceHeaders))

  const invitation = await auth.api.createInvitation({
    body: { email: 'bob@example.com', role: 'member' },
    headers: aliceHeaders,
  })

  return expect(
    auth.api.acceptInvitation({ body: { invitationId: invitation.id }, headers: malloryHeaders }),
  ).rejects.toThrow()
})

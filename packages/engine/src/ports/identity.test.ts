import { describe, expect, test } from 'bun:test'

import {
  actorOfActing,
  firstIdentity,
  noIdentity,
  orgOfActing,
  ownerOfActing,
  personIdentity,
  serviceIdentity,
  type ActingFor,
} from './identity'

const TOKEN = 'a-service-token-of-thirty-two-characters'

function call(headers: Record<string, string>): Request {
  return new Request('https://shuttle.test/api', { headers })
}

describe('serviceIdentity', () => {
  const port = serviceIdentity({ token: TOKEN, service: 'build-host' })

  test('acts for an organization when no person is named', async () => {
    const acting = await port.resolve(
      call({ authorization: `Bearer ${TOKEN}`, 'x-shuttle-org': 'org1' }),
    )

    expect(acting).toEqual({ kind: 'organization', orgId: 'org1', service: 'build-host' })
  })

  test('acts for the person it names, in their organization', async () => {
    const acting = await port.resolve(
      call({
        authorization: `Bearer ${TOKEN}`,
        'x-shuttle-org': 'org1',
        'x-shuttle-user': 'user_1',
        'x-shuttle-user-name': 'Ada',
      }),
    )

    expect(acting).toEqual({
      kind: 'person',
      actor: { userId: 'user_1', orgId: 'org1', role: 'member', name: 'Ada', email: '' },
    })
  })

  test('knows nobody who has the wrong secret or none', async () => {
    expect(
      await port.resolve(call({ authorization: 'Bearer nope', 'x-shuttle-org': 'org1' })),
    ).toBeNull()

    expect(await port.resolve(call({ 'x-shuttle-org': 'org1' }))).toBeNull()
  })

  test('knows nobody whose organization or person is not an id', async () => {
    const bearer = { authorization: `Bearer ${TOKEN}` }

    expect(await port.resolve(call({ ...bearer, 'x-shuttle-org': 'o-1/../x' }))).toBeNull()
    expect(await port.resolve(call(bearer))).toBeNull()

    expect(
      await port.resolve(call({ ...bearer, 'x-shuttle-org': 'org1', 'x-shuttle-user': '../x' })),
    ).toBeNull()
  })

  test('refuses a weak secret or a name that is not one', () => {
    expect(() => serviceIdentity({ token: 'short', service: 'host' })).toThrow()
    expect(() => serviceIdentity({ token: TOKEN, service: 'bad name!' })).toThrow()
  })
})

describe('acting for', () => {
  const person: ActingFor = {
    kind: 'person',
    actor: { userId: 'u1', orgId: 'org1', role: 'admin', name: 'Ada', email: 'ada@example.com' },
  }

  const organization: ActingFor = { kind: 'organization', orgId: 'org2', service: 'build-host' }

  test('a person owns what they start; an organization owns nothing', () => {
    expect(ownerOfActing(person)).toBe('u1')
    expect(ownerOfActing(organization)).toBeNull()
    expect(orgOfActing(person)).toBe('org1')
    expect(orgOfActing(organization)).toBe('org2')
  })

  test('an organization acts as a member named for its service', () => {
    expect(actorOfActing(person)).toBe(person.actor)
    expect(actorOfActing(organization)).toMatchObject({ orgId: 'org2', role: 'member' })
  })
})

describe('composing identities', () => {
  test('the first port that knows the request answers', async () => {
    const person = personIdentity(async () => null)
    const service = serviceIdentity({ token: TOKEN, service: 'build-host' })
    const both = firstIdentity(person, noIdentity, service)

    const acting = await both.resolve(
      call({ authorization: `Bearer ${TOKEN}`, 'x-shuttle-org': 'org1' }),
    )

    expect(acting?.kind).toBe('organization')
    expect(await both.resolve(call({}))).toBeNull()
  })
})

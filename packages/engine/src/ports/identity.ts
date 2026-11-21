import { isOrgId } from '@shuttle/api'

import type { Actor } from '../tenancy/access'

/**
 * Who a request, or a host call, acts for: the host port for identity and tenancy.
 *
 * Shuttle's own app acts for a signed-in person inside their organization. A host that drives
 * Shuttle from a service acts for a named person, or for an organization with no person behind it.
 * Everything below this (who owns a session, whose organization's runs it may reach) is worked out
 * from the answer.
 */
export type ActingFor =
  | { readonly kind: 'person'; readonly actor: Actor }
  /** An organization acting through a named service. No person owns what it starts. */
  | { readonly kind: 'organization'; readonly orgId: string; readonly service: string }

export interface IdentityPort {
  /** Who the request acts for, or null when it is not from anyone this port knows. */
  resolve(request: Request): Promise<ActingFor | null>
}

export function orgOfActing(acting: ActingFor): string {
  return acting.kind === 'person' ? acting.actor.orgId : acting.orgId
}

/**
 * The person who owns what this starts. Null for an organization, so what it starts is open to
 * the whole organization, like a session Shuttle started itself.
 */
export function ownerOfActing(acting: ActingFor): string | null {
  return acting.kind === 'person' ? acting.actor.userId : null
}

/** The `Actor` the HTTP layer works with. An organization's is a member named for its service. */
export function actorOfActing(acting: ActingFor): Actor {
  if (acting.kind === 'person') {
    return acting.actor
  }

  return {
    userId: `service_${acting.service}`,
    orgId: acting.orgId,
    role: 'member',
    name: acting.service,
    email: '',
  }
}

/** Shuttle's own behaviour: the signed-in person, as `resolve` finds them. */
export function personIdentity(resolve: (request: Request) => Promise<Actor | null>): IdentityPort {
  return {
    resolve: async (request) => {
      const actor = await resolve(request)

      return actor === null ? null : { kind: 'person', actor }
    },
  }
}

/** The first port that knows the request. Ports are tried in order. */
export function firstIdentity(...ports: readonly IdentityPort[]): IdentityPort {
  return {
    resolve: async (request) => {
      for (const port of ports) {
        const acting = await port.resolve(request)

        if (acting !== null) {
          return acting
        }
      }

      return null
    },
  }
}

export const ORG_HEADER = 'x-shuttle-org'
export const USER_HEADER = 'x-shuttle-user'
export const USER_NAME_HEADER = 'x-shuttle-user-name'

const USER_ID = /^[A-Za-z0-9_-]{1,64}$/
const SERVICE_NAME = /^[A-Za-z0-9-]{1,40}$/

export interface ServiceIdentityOptions {
  /** The shared secret a host presents as `Authorization: Bearer <token>`. */
  readonly token: string
  /** Names the host, for what it starts and for the log. Letters, digits and hyphens. */
  readonly service: string
}

/** Compares without stopping at the first difference, so timing says nothing about the secret. */
function sameSecret(given: string, expected: string): boolean {
  const left = new TextEncoder().encode(given)
  const right = new TextEncoder().encode(expected)
  let difference = left.length ^ right.length

  for (let index = 0; index < right.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }

  return difference === 0
}

/**
 * A host calling on behalf of an organization, or of one person in it. The host proves itself
 * with a shared secret and names who it acts for in headers: `x-shuttle-org` always, and
 * `x-shuttle-user` when a person is behind the call. A call with the wrong secret, or one that
 * names an organization or a person that cannot be an id, is not from anyone.
 */
export function serviceIdentity(options: ServiceIdentityOptions): IdentityPort {
  if (options.token.length < 32) {
    throw new Error('a service identity needs a token of at least 32 characters')
  }

  if (!SERVICE_NAME.test(options.service)) {
    throw new Error('a service identity needs a name of letters, digits and hyphens')
  }

  return {
    resolve: async (request) => {
      const header = request.headers.get('authorization') ?? ''
      const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''

      if (presented === '' || !sameSecret(presented, options.token)) {
        return null
      }

      const orgId = request.headers.get(ORG_HEADER)

      if (!isOrgId(orgId)) {
        return null
      }

      const userId = request.headers.get(USER_HEADER)

      if (userId === null) {
        return { kind: 'organization', orgId, service: options.service }
      }

      if (!USER_ID.test(userId)) {
        return null
      }

      return {
        kind: 'person',
        actor: {
          userId,
          orgId,
          role: 'member',
          name: request.headers.get(USER_NAME_HEADER) ?? userId,
          email: '',
        },
      }
    },
  }
}

/** For a host that has no HTTP edge, or has not decided who may call: nobody is known. */
export const noIdentity: IdentityPort = { resolve: async () => null }

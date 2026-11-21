import { personIdentity, type IdentityPort, type ShuttleHost } from '@shuttle/engine'
import type { PeoplePort } from '@shuttle/engine/ports/people'
import type { PreviewKeys } from '@shuttle/engine/ports/previews'

import { resolveActor } from './auth/actor'
import { getAuth } from './auth/auth'
import type { ShuttleEnv } from './env'
import { previewKeyFor, runOfPreviewKey } from './tenancy/previews'

/** Shuttle's own Worker acts for the person signed in to the request. */
export function workerIdentity(env: ShuttleEnv): IdentityPort {
  return personIdentity((request) => resolveActor(getAuth(env), request))
}

/** The people of an organization, as the sign-in store has them. */
export function workerPeople(env: ShuttleEnv): PeoplePort {
  return {
    members: async (orgId, request) => {
      const { members } = await getAuth(env).api.listMembers({
        headers: request.headers,
        query: { organizationId: orgId, limit: 1000 },
      })

      return members.map((member) => member.userId)
    },
  }
}

/** Preview keys, kept in the sign-in database. Null without one: there are no previews then. */
export function workerPreviews(env: ShuttleEnv): PreviewKeys | null {
  const db = env.AUTH_DB

  return db === undefined
    ? null
    : { keyFor: (runId) => previewKeyFor(db, runId), runOf: (key) => runOfPreviewKey(db, key) }
}

/**
 * Shuttle's own Worker as a host of the engine: its environment, the signed-in person as the one
 * it acts for, and its sign-in database for who is in an organization and for preview keys.
 * Every other port is left to the engine's standalone behaviour.
 */
export function workerHost(env: ShuttleEnv): ShuttleHost {
  return {
    env,
    ports: {
      identity: workerIdentity(env),
      people: workerPeople(env),
      previews: workerPreviews(env),
    },
  }
}

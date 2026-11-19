import { personIdentity, type IdentityPort, type ShuttleHost } from '@shuttle/engine'

import { resolveActor } from './auth/actor'
import { getAuth } from './auth/auth'
import type { ShuttleEnv } from './env'

/** Shuttle's own Worker acts for the person signed in to the request. */
export function workerIdentity(env: ShuttleEnv): IdentityPort {
  return personIdentity((request) => resolveActor(getAuth(env), request))
}

/**
 * Shuttle's own Worker as a host of the engine: its environment, and the signed-in person as the
 * one it acts for. Every other port is left to the engine's standalone behaviour.
 */
export function workerHost(env: ShuttleEnv): ShuttleHost {
  return {
    env,
    ports: { identity: workerIdentity(env) },
  }
}

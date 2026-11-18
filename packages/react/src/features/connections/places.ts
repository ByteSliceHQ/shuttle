import type { Connection } from '@shuttle/api'

import { type CallContext, type ShuttleHost } from '../../shuttle'

/** Where a session runs, and so which sign-in it uses. */
export type SignInPlace = 'local' | 'cloud'

/** Whether the agent is signed in at `place`. Null when that cannot be known from here. */
export function signedInAt(connection: Connection, place: SignInPlace): boolean | null {
  return place === 'cloud' ? connection.cloud : connection.local
}

/**
 * Whether an agent can run at `place`. False only when it is known not to be signed in there,
 * so a place that cannot be checked from here never blocks anyone.
 */
export function needsSignIn(
  connection: Connection | undefined,
  place: SignInPlace | null,
): connection is Connection {
  return Boolean(connection && place && signedInAt(connection, place) === false)
}

/** The words for a place, as in "signed in on this machine". */
export function placeName(place: SignInPlace): string {
  return place === 'local' ? 'this machine' : 'the cloud'
}

/** "on this machine" or "in the cloud". */
export function atPlace(place: SignInPlace): string {
  return place === 'local' ? 'on this machine' : 'in the cloud'
}

/**
 * What a sign-in, disconnect or follow at `place` sends. One at `local` names this machine, so
 * it happens in this machine's sandbox. One at `cloud` names none, even from the desktop app.
 */
export function placeContext(host: ShuttleHost, place: SignInPlace): CallContext {
  return place === 'local' ? host.deviceContext() : {}
}

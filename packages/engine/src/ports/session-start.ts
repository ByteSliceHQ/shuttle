import type { ActingFor } from './identity'

/**
 * What starts a session: the host port that is asked before any session begins.
 *
 * A standalone Shuttle starts a session when a person types a goal into a folder, and when it
 * opens a review of a pull request on its own. A host adds its own triggers (a build host starts
 * one from a work item) and decides whether each start may go ahead, which is where an
 * entitlement check or a usage meter sits. The standalone answer is yes.
 */
export type SessionStartKind =
  /** A person started it, from a folder in Shuttle's own app. */
  | 'person'
  /** Shuttle opened a review of a pull request, with nobody's name on it. */
  | 'auto-review'
  /** The host started it, headless, from a repository and a brief. */
  | 'host'

export interface SessionStartRequest {
  readonly kind: SessionStartKind
  readonly orgId: string
  /** Who the session is for. Null when nobody asked, as for an automatic review. */
  readonly acting: ActingFor | null
  /** Full names of the repositories the session will work in. */
  readonly repos: readonly string[]
}

export type SessionStartVerdict =
  | { readonly allowed: true }
  /** `reason` is written for a person to read. */
  | { readonly allowed: false; readonly reason: string }

export interface SessionStartPort {
  admit(request: SessionStartRequest): Promise<SessionStartVerdict>
}

/** Shuttle's own behaviour: every start is allowed. */
export const openSessionStart: SessionStartPort = {
  admit: async () => ({ allowed: true }),
}

export class SessionStartRefusedError extends Error {
  constructor(readonly reason: string) {
    super(`session not started: ${reason}`)
    this.name = 'SessionStartRefusedError'
  }
}

/** Resolves when the start is allowed, and throws `SessionStartRefusedError` when it is not. */
export async function admitSessionStart(
  port: SessionStartPort,
  request: SessionStartRequest,
): Promise<void> {
  const verdict = await port.admit(request)

  if (!verdict.allowed) {
    throw new SessionStartRefusedError(verdict.reason)
  }
}

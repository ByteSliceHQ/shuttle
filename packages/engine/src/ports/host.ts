import type { GitAccess } from '@shuttle/git/access'
import type { LoomsIds } from '@swirls/looms/core'
import type { Projector } from '@swirls/looms/projectors'

import type { EngineEnv } from '../env'
import { neverExpire, type ApprovalPolicy } from './approvals'
import { sponsorCredentials, type CredentialPort } from './credentials'
import { noIdentity, type IdentityPort } from './identity'
import { noPeople, type PeoplePort } from './people'
import type { PreviewKeys } from './previews'
import { openSessionStart, type SessionStartPort } from './session-start'

/**
 * Everything a host can supply in place of Shuttle's own behaviour. Each port is optional: what
 * a host leaves out is what a standalone Shuttle does.
 */
export interface HostPorts {
  /** Who a request acts for. Standalone: the signed-in person (supplied by the app). */
  readonly identity: IdentityPort
  /** What may start a session. Standalone: everything. */
  readonly sessionStart: SessionStartPort
  /**
   * Whose credential a vendor agent turn runs on, and the API keys the host holds. Standalone: the
   * person it works for, on their own sign-in.
   */
  readonly credentials: CredentialPort
  /** How long an approval waits, and whether the host decides it. Standalone: a person, forever. */
  readonly approvals: ApprovalPolicy
  /** GitHub access. Standalone: Shuttle's own GitHub App, from `env`. */
  readonly git: GitAccess | null
  /** Who is in an organization, for sharing a session. Standalone: supplied by the app. */
  readonly people: PeoplePort
  /** Where preview keys are kept. Without one, sessions have no previews. */
  readonly previews: PreviewKeys | null
}

/**
 * What a host gives Shuttle: its resources and settings (`env`) and the ports it replaces. This,
 * and not the Worker's whole environment, is what `shuttleModules` takes.
 */
export interface ShuttleHost {
  readonly env: EngineEnv
  readonly ports?: Partial<HostPorts>
  /**
   * What the host also copies a run's events to, beside what Shuttle projects itself: an event
   * log, a stream, an index of its own. Asked once for each run, when its object is configured,
   * with the run's id. Standalone: nothing more.
   */
  readonly projectors?: (run: { readonly runId: string }) => readonly Projector[]
  /**
   * How a run's ids are written: its threads, events and waits, and the child threads a session
   * names. Looms's interface, given to every run's object and to the routes that reach one, so a
   * host that keeps run data in its own tables gets ids in its own format. Standalone: Looms's
   * TypeIDs. In a browser, pass the same format through `runStore` on the React host.
   */
  readonly ids?: LoomsIds
}

/** The projectors a run gets: Shuttle's own first, then the host's, in the order it gave them. */
export function projectorsFor(
  host: ShuttleHost,
  runId: string,
  own: readonly Projector[],
): Projector[] {
  return [...own, ...(host.projectors?.({ runId }) ?? [])]
}

export interface ResolvedHost {
  /** `host.env`, with the host's Git access in place when it supplied one. */
  readonly env: EngineEnv
  readonly ports: HostPorts
  /** The host's id format, when it gave one. */
  readonly ids?: LoomsIds
}

/** Fills in Shuttle's own behaviour for every port the host left out. */
export function resolveHost(host: ShuttleHost): ResolvedHost {
  const supplied = host.ports ?? {}
  const git = supplied.git ?? null

  return {
    env: git === null ? host.env : { ...host.env, GIT_ACCESS: git },
    ports: {
      identity: supplied.identity ?? noIdentity,
      sessionStart: supplied.sessionStart ?? openSessionStart,
      credentials: supplied.credentials ?? sponsorCredentials,
      approvals: supplied.approvals ?? neverExpire,
      git,
      people: supplied.people ?? noPeople,
      previews: supplied.previews ?? null,
    },
    ids: host.ids,
  }
}

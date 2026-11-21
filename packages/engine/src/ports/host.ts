import type { GitAccess } from '@shuttle/git/access'

import type { EngineEnv } from '../env'
import { neverExpire, type ApprovalPolicy } from './approvals'
import { sponsorCredentials, type CredentialPort } from './credentials'
import { noIdentity, type IdentityPort } from './identity'
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
  /** How long an approval waits. Standalone: forever. */
  readonly approvals: ApprovalPolicy
  /** GitHub access. Standalone: Shuttle's own GitHub App, from `env`. */
  readonly git: GitAccess | null
}

/**
 * What a host gives Shuttle: its resources and settings (`env`) and the ports it replaces. This,
 * and not the Worker's whole environment, is what `shuttleModules` takes.
 */
export interface ShuttleHost {
  readonly env: EngineEnv
  readonly ports?: Partial<HostPorts>
}

export interface ResolvedHost {
  /** `host.env`, with the host's Git access in place when it supplied one. */
  readonly env: EngineEnv
  readonly ports: HostPorts
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
    },
  }
}

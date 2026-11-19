/**
 * What a host imports to run Shuttle inside its own Worker.
 *
 * A host's Durable Object class extends `LoomsDurableObject` and returns
 * `shuttleModules({ env, ports }, runId, { storage })` from `configure`. Everything it does not
 * pass in `ports` is what a standalone Shuttle does. See `docs/hosting.md`.
 */
export { shuttleModules, type ShuttleModulesOptions } from './modules'
export type { EngineEnv } from './env'

export { resolveHost, type HostPorts, type ResolvedHost, type ShuttleHost } from './ports/host'

export {
  actorOfActing,
  firstIdentity,
  noIdentity,
  orgOfActing,
  ownerOfActing,
  personIdentity,
  serviceIdentity,
  type ActingFor,
  type IdentityPort,
  type ServiceIdentityOptions,
} from './ports/identity'

export {
  admitSessionStart,
  openSessionStart,
  SessionStartRefusedError,
  type SessionStartKind,
  type SessionStartPort,
  type SessionStartRequest,
  type SessionStartVerdict,
} from './ports/session-start'

export {
  billedToLabel,
  credentialKey,
  type CredentialAccess,
  type CredentialOwner,
  type CredentialPort,
  type TurnCredentialRequest,
} from './ports/credentials'
export { workspaceCredentials } from './ports/workspace-credentials'

export {
  expiryOf,
  hasExpired,
  neverExpire,
  type ApprovalKind,
  type ApprovalPolicy,
  type ApprovalRequestInfo,
} from './ports/approvals'

export {
  answerHeadlessQuestion,
  headlessOutcome,
  HeadlessRequestError,
  startHeadlessSession,
  type HeadlessRepository,
  type HeadlessSession,
  type HeadlessSessionRequest,
} from './headless/start'

export {
  outcomeOf,
  sessionOutcome,
  type SessionOutcome,
  type SessionPullRequest,
  type SessionQuestion,
} from './headless/outcome'

/**
 * What a host imports to run Shuttle inside its own Worker.
 *
 * A host's Durable Object class extends `ShuttleRun` (from `@shuttle/engine/worker`) and says who
 * the host is: `{ env, ports }`. Everything it does not pass in `ports` is what a standalone
 * Shuttle does. Nothing here needs a Worker to load, so a host's own code and tests can import it
 * anywhere. See `docs/hosting.md`.
 */
export { shuttleModules, type ShuttleModulesOptions } from './modules'
export type { EngineEnv } from './env'
export type { LoomsRunStub } from './looms-stub'
export type { Actor, SessionAccess } from './tenancy/access'

export { fixedGitAccess, type GitAccess } from '@shuttle/git/access'

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
  sponsorCredentials,
  type CredentialAccess,
  type CredentialOwner,
  type CredentialPort,
  type TurnCredentialRequest,
} from './ports/credentials'

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
  headlessSessions,
  startHeadlessSession,
  type HeadlessAnswer,
  type HeadlessRepository,
  type HeadlessSession,
  type HeadlessSessionRequest,
  type HeadlessSessions,
} from './headless/start'

export {
  outcomeOf,
  sessionOutcome,
  type SessionOutcome,
  type SessionPullRequest,
  type SessionQuestion,
} from './headless/outcome'

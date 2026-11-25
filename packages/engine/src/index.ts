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
  type ModelKeyRequest,
  type TurnCredentialRequest,
} from './ports/credentials'

export {
  expiryOf,
  hasExpired,
  neverExpire,
  POLICY_DECIDER,
  type ApprovalDecisionRequest,
  type ApprovalKind,
  type ApprovalPolicy,
  type ApprovalRequestInfo,
  type ApprovalVerdict,
  type PullRequestProposal,
  type ReviewProposal,
} from './ports/approvals'

export {
  answerHeadlessQuestion,
  headlessOutcome,
  HeadlessRequestError,
  headlessSessions,
  sendHeadlessMessage,
  startHeadlessSession,
  stopHeadlessSession,
  type HeadlessAnswer,
  type HeadlessMessage,
  type HeadlessRepository,
  type HeadlessSession,
  type HeadlessSessionRequest,
  type HeadlessSessions,
} from './headless/start'

export {
  outcomeOf,
  sessionOutcome,
  type QuestionKind,
  type SessionOutcome,
  type SessionPullRequest,
  type SessionQuestion,
} from './headless/outcome'

export { noPeople, type PeoplePort } from './ports/people'
export type { PreviewKeys } from './ports/previews'

export {
  assetsApi,
  firehoseApi,
  portableApiModules,
  serveShuttle,
  sessionApi,
  terminalApi,
  type ApiModule,
  type ServeOptions,
} from './api/serve'
export type { ApiContext } from './api/base'

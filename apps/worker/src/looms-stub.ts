import type { EventInput, JsonValue, RunState, RunStatusSnapshot } from '@swirls/looms/core'

import type { CredentialPayload, CredentialSummary } from './credentials/store'
import type { ShuttleEnv } from './env'
import type { HarnessId, VendorHarnessId } from './harness'
import type { LinkedSandboxRepo } from './sandbox/workspace'
import type { SandboxPlacement } from './session/bind-sandbox'
import type { DigestSource } from './session/digest-source'
import type { PendingPlacement, SessionMove } from './session/handoff'
import type { SessionStacks } from './session/stack-state'
import type { Team, TeamInput } from './team'
import type { SessionAccess } from './tenancy/access'
import type {
  VendorCatalogue,
  VendorModel,
  VendorModelChoice,
  VendorModelChoiceInput,
  VendorModelChoices,
} from './vendor/models'
import type { SessionActivity } from './workspace/module'

/** Narrow RPC surface we call on Looms Durable Object stubs. */
export interface LoomsRunStub {
  fetch(request: Request): Promise<Response>
  launch(args: {
    kind: string
    definitionName: string
    definitionVersion?: string
    input?: JsonValue
    attributes?: Record<string, string>
  }): Promise<void>
  status(): Promise<RunStatusSnapshot | null>
  /**
   * `wake: 'schedule'` answers once the events are committed and leaves the run to act on them
   * afterwards. Without it the call waits until the run parks, which can be a whole agent turn.
   */
  signal(
    events: ReadonlyArray<EventInput>,
    options?: { wake?: 'await' | 'schedule' },
  ): Promise<RunState>
  getRun(): Promise<RunState>
  startRun(args: {
    kind: string
    definitionName: string
    input?: JsonValue
  }): Promise<{ runId: string }>
  getLlmModel(): Promise<{ model: string }>
  setLlmModel(model: string): Promise<{ model: string }>
  getHarness(): Promise<{ harness: HarnessId }>
  setHarness(harness: string): Promise<{ harness: HarnessId }>
  getTeam(): Promise<{ team: Team }>
  setTeam(team: TeamInput | null): Promise<{ team: Team }>
  getVendorModelChoices(): Promise<{ choices: VendorModelChoices }>
  setVendorModelChoice(
    harness: VendorHarnessId,
    choice: VendorModelChoiceInput | null,
  ): Promise<{ choice: VendorModelChoice }>
  getVendorCatalogue(harness: VendorHarnessId): Promise<VendorCatalogue | null>
  putVendorCatalogue(
    harness: VendorHarnessId,
    models: readonly VendorModel[],
  ): Promise<VendorCatalogue>
  getStreamTail(): Promise<number>
  getCredential(userId: string, harness: VendorHarnessId): Promise<CredentialPayload | null>
  putCredential(userId: string, harness: VendorHarnessId, payload: CredentialPayload): Promise<void>
  removeCredential(userId: string, harness: VendorHarnessId): Promise<boolean>
  listCredentials(userId: string): Promise<CredentialSummary[]>
  getAccess(): Promise<SessionAccess | null>
  setAccess(access: SessionAccess): Promise<SessionAccess>
  getSandboxName(): Promise<string | null>
  getSandboxPlacement(): Promise<SandboxPlacement | null>
  placeSandbox(
    placement: SandboxPlacement | null,
  ): Promise<{ sandboxName: string | null; moved: SessionMove | null }>
  placeSandboxLater(placement: SandboxPlacement | null): Promise<{ ok: true }>
  getSandboxMoves(): Promise<{ pending: PendingPlacement | null; last: SessionMove | null }>
  getSessionRepos(): Promise<readonly LinkedSandboxRepo[]>
  getDigestSource(): Promise<DigestSource>
  getSessionStacks(): Promise<SessionStacks>
  getSessionActivitySnapshot(): Promise<{ activity: SessionActivity; tail: number } | null>
}

export function loomsStub(namespace: ShuttleEnv['LOOMS_RUN'], runId: string): LoomsRunStub {
  return namespace.getByName(runId)
}

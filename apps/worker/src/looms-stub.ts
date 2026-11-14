import type { EventInput, JsonValue, RunState, RunStatusSnapshot } from '@swirls/looms/core'

import type { CredentialPayload, CredentialSummary } from './credentials/store'
import type { ShuttleEnv } from './env'
import type { HarnessId, VendorHarnessId } from './harness'
import type { LinkedSandboxRepo } from './sandbox/workspace'
import type { Team } from './team'
import type { SessionAccess } from './tenancy/access'
import type {
  VendorCatalogue,
  VendorModel,
  VendorModelChoice,
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
  signal(events: ReadonlyArray<EventInput>): Promise<RunState>
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
  setTeam(team: unknown): Promise<{ team: Team }>
  getVendorModelChoices(): Promise<{ choices: VendorModelChoices }>
  setVendorModelChoice(
    harness: VendorHarnessId,
    choice: unknown,
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
  setAccess(access: unknown): Promise<SessionAccess>
  getSandboxName(): Promise<string | null>
  getSessionRepos(): Promise<readonly LinkedSandboxRepo[]>
  getSessionActivitySnapshot(): Promise<{ activity: SessionActivity; tail: number } | null>
}

export function loomsStub(namespace: ShuttleEnv['LOOMS_RUN'], runId: string): LoomsRunStub {
  return namespace.getByName(runId)
}

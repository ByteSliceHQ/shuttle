import type { EventInput, JsonValue, RunState, RunStatusSnapshot } from '@swirls/looms/core'

import type { CredentialPayload, CredentialSummary } from './credentials/store'
import type { ShuttleEnv } from './env'
import type { HarnessId, VendorHarnessId } from './harness'
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
  getStreamTail(): Promise<number>
  getCredential(harness: VendorHarnessId): Promise<CredentialPayload | null>
  putCredential(harness: VendorHarnessId, payload: CredentialPayload): Promise<void>
  removeCredential(harness: VendorHarnessId): Promise<boolean>
  listCredentials(): Promise<CredentialSummary[]>
  getSessionActivitySnapshot(): Promise<{ activity: SessionActivity; tail: number } | null>
}

export function loomsStub(namespace: ShuttleEnv['LOOMS_RUN'], runId: string): LoomsRunStub {
  return namespace.getByName(runId)
}

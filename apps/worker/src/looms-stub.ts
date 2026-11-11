import type { EventInput, JsonValue, RunState, RunStatusSnapshot } from '@swirls/looms/core'

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
  getStreamTail(): Promise<number>
  getSessionActivitySnapshot(): Promise<{ activity: SessionActivity; tail: number } | null>
}

export function loomsStub(namespace: DurableObjectNamespace, runId: string): LoomsRunStub {
  // Cloudflare RPC exposes these methods on the stub at runtime.
  return namespace.getByName(runId) as unknown as LoomsRunStub
}

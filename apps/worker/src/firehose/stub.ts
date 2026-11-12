import type { EventEnvelope } from '@swirls/looms/core'

import type { ShuttleEnv } from '../env'

const FIREHOSE_NAME = 'global'

export interface EventFirehoseStub {
  fetch(request: Request): Promise<Response>
  ingest(runId: string, events: ReadonlyArray<EventEnvelope>): Promise<{ inserted: number }>
}

export function firehoseStub(env: ShuttleEnv): EventFirehoseStub {
  return env.EVENT_FIREHOSE.getByName(FIREHOSE_NAME) as unknown as EventFirehoseStub
}

import type { EventEnvelope } from '@swirls/looms/core'

import type { EngineEnv } from '../env'

/** The firehose of a run that belongs to no organization (unit tests, data from before them). */
const UNSCOPED_FIREHOSE = 'global'

export interface EventFirehoseStub {
  fetch(request: Request): Promise<Response>
  ingest(runId: string, events: ReadonlyArray<EventEnvelope>): Promise<{ inserted: number }>
}

/** Each organization has its own firehose, so its events never mix with another's. */
export function firehoseStub(env: EngineEnv, orgId: string | null): EventFirehoseStub {
  return env.EVENT_FIREHOSE.getByName(orgId ?? UNSCOPED_FIREHOSE)
}

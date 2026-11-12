import type { EventEnvelope } from '@swirls/looms/core'
import type { Projector } from '@swirls/looms/projectors'

import type { ShuttleEnv } from '../env'
import { firehoseStub } from './stub'

/** Fan committed run events into the singleton global firehose. */
export function createFirehoseProjector(env: ShuttleEnv, runId: string): Projector {
  return {
    name: 'firehose',
    version: '1',
    async project(events: ReadonlyArray<EventEnvelope>): Promise<void> {
      if (events.length === 0) {
        return
      }

      await firehoseStub(env).ingest(runId, events)
    },
  }
}

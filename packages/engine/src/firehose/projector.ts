import type { EventEnvelope } from '@swirls/looms/core'
import type { Projector } from '@swirls/looms/projectors'

import type { EngineEnv } from '../env'
import { loomsStub } from '../looms-stub'
import { isPublicSession, readSessionAccess } from '../tenancy/access'
import { orgOfRun, parsePersonalRunId, sessionOfReflection } from '../tenancy/run-id'
import { runKindFor } from './run-kind'
import { firehoseStub } from './stub'

/**
 * Whether a run's events must stay out of the organization's firehose, which every member can
 * read: a private session, the reflection on one, and a person's own workspace.
 */
export async function isPrivateRun(
  env: EngineEnv,
  runId: string,
  storage?: Pick<DurableObjectStorage, 'get' | 'put'>,
): Promise<boolean> {
  if (parsePersonalRunId(runId)) {
    return true
  }

  if (runKindFor(env, runId) !== 'session') {
    return false
  }

  const session = sessionOfReflection(runId)

  // A session's access is in its own storage; a reflection has to ask its session.
  const access =
    session === runId
      ? storage
        ? await readSessionAccess(storage)
        : null
      : await loomsStub(env.LOOMS_RUN, session).getAccess()

  return !isPublicSession(access)
}

/** Fan committed run events into the firehose of the run's organization, unless they are private. */
export function createFirehoseProjector(
  env: EngineEnv,
  runId: string,
  storage?: DurableObjectStorage,
): Projector {
  return {
    name: 'firehose',
    version: '1',
    async project(events: ReadonlyArray<EventEnvelope>): Promise<void> {
      // Checked on every batch: a session can be made public or private at any time.
      if (events.length === 0 || (await isPrivateRun(env, runId, storage))) {
        return
      }

      await firehoseStub(env, orgOfRun(runId)).ingest(runId, events)
    },
  }
}

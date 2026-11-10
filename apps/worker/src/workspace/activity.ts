import { readRunLaunchSource, type EventEnvelope, type JsonValue } from '@swirls/looms/core'
import type { Projector } from '@swirls/looms/projectors'

import { workspaceRunId } from '../config'
import type { ShuttleEnv } from '../env'
import { loomsStub } from '../looms-stub'
import { reportActivity, type SessionActivity } from './module'

function activityFromEvent(event: EventEnvelope): SessionActivity | null {
  switch (event.type) {
    case 'agent.turn.started':
    case 'agent.tool.requested':
    case 'agent.tool.started':
      return 'working'

    case 'approval.requested':
      return 'needs_input'

    case 'approval.decided':
    case 'agent.turn.completed':
    case 'agent.turn.stopped':
    case 'runtime.run.completed':
    case 'runtime.run.cancelled':
    case 'runtime.thread.completed':
    case 'runtime.thread.failed':
    case 'runtime.thread.cancelled':
      return 'idle'

    default:
      return null
  }
}

const MEMBER_KEY = 'workspace-activity:launched-by-workspace'

/**
 * Push session activity to the singleton workspace run so the sidebar can show
 * working / needs_input / idle dots without D1.
 *
 * Only runs the workspace launched report, so the playbook and legacy sessions never
 * signal (and thereby implicitly create) the workspace run before it is launched.
 */
export function createWorkspaceActivityProjector(
  env: ShuttleEnv,
  runId: string,
  storage?: DurableObjectStorage,
): Projector {
  const workspaceId = workspaceRunId(env)
  let member: boolean | undefined

  async function launchedByWorkspace(events: ReadonlyArray<EventEnvelope>): Promise<boolean> {
    const started = events.find((event) => event.type === 'runtime.run.started')

    if (started) {
      const payload = started.payload as { launchedBy?: JsonValue }
      member = readRunLaunchSource(payload.launchedBy)?.runId === workspaceId
      await storage?.put(MEMBER_KEY, member)
      return member
    }

    member ??= (await storage?.get<boolean>(MEMBER_KEY)) ?? false
    return member
  }

  return {
    name: 'workspace-activity',
    version: '2',
    async project(events: ReadonlyArray<EventEnvelope>): Promise<void> {
      if (runId === workspaceId || events.length === 0) {
        return
      }

      if (!(await launchedByWorkspace(events))) {
        return
      }

      let latest: { activity: SessionActivity; at: number; seq: number } | null = null

      for (const event of events) {
        const activity = activityFromEvent(event)

        if (!activity) {
          continue
        }

        latest = {
          activity,
          at: typeof event.ts === 'number' ? event.ts : Date.now(),
          seq: event.seq,
        }
      }

      if (!latest) {
        return
      }

      const stub = loomsStub(env.LOOMS_RUN, workspaceId)

      const built = reportActivity({
        runId,
        activity: latest.activity,
        at: latest.at,
      })

      await stub.signal(
        [
          {
            ...built,
            idempotencyKey: `activity:${runId}:${latest.seq}`,
          },
        ],
        // LoomsRunStub.signal only takes events; idempotency is on the event.
      )
    },
  }
}

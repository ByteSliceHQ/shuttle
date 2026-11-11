import { readRunLaunchSource, type EventEnvelope, type JsonValue } from '@swirls/looms/core'
import type { Projector } from '@swirls/looms/projectors'

import { workspaceRunId } from '../config'
import type { ShuttleEnv } from '../env'
import { loomsStub } from '../looms-stub'
import {
  deriveSessionActivity,
  initialSessionActivityState,
  reduceSessionActivity,
  type SessionActivityState,
} from './activity-state'
import { reportActivity, type SessionActivity } from './module'

const MEMBER_KEY = 'workspace-activity:launched-by-workspace'
const CHECKPOINT_KEY = 'workspace-activity:v4:checkpoint'
const WORKING_HEARTBEAT_MS = 60_000

interface ActivityCheckpoint {
  readonly cursor: number
  readonly state: SessionActivityState
  readonly lastTransitionAt: number
  readonly lastTransitionSeq: number
  readonly reported: {
    readonly activity: SessionActivity
    readonly at: number
  } | null
}

const emptyCheckpoint: ActivityCheckpoint = {
  cursor: -1,
  state: initialSessionActivityState,
  lastTransitionAt: 0,
  lastTransitionSeq: 0,
  reported: null,
}

function eventTimestamp(event: EventEnvelope): number {
  return typeof event.ts === 'number' && Number.isFinite(event.ts) ? event.ts : Date.now()
}

/**
 * Push session activity to the singleton workspace run so the sidebar can show
 * working / needs_input / error / idle states without D1.
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
  let cachedCheckpoint: ActivityCheckpoint | undefined

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

  async function loadCheckpoint(firstSeq: number): Promise<ActivityCheckpoint> {
    if (firstSeq <= 1) {
      const hasZeroSeq = firstSeq === 0

      if (hasZeroSeq) {
        return emptyCheckpoint
      }

      cachedCheckpoint ??=
        (await storage?.get<ActivityCheckpoint>(CHECKPOINT_KEY)) ?? emptyCheckpoint

      return cachedCheckpoint.cursor <= 0 ? cachedCheckpoint : emptyCheckpoint
    }

    cachedCheckpoint ??= (await storage?.get<ActivityCheckpoint>(CHECKPOINT_KEY)) ?? emptyCheckpoint
    return cachedCheckpoint
  }

  async function saveCheckpoint(checkpoint: ActivityCheckpoint): Promise<void> {
    cachedCheckpoint = checkpoint
    await storage?.put(CHECKPOINT_KEY, checkpoint)
  }

  return {
    name: 'workspace-activity',
    version: '4',
    async project(events: ReadonlyArray<EventEnvelope>): Promise<void> {
      if (runId === workspaceId || events.length === 0) {
        return
      }

      if (!(await launchedByWorkspace(events))) {
        return
      }

      const first = events[0]

      if (!first) {
        return
      }

      let checkpoint = await loadCheckpoint(first.seq)
      let prevActivity = checkpoint.cursor >= 0 ? deriveSessionActivity(checkpoint.state) : null

      for (const event of events) {
        if (event.seq <= checkpoint.cursor) {
          continue
        }

        const nextState = reduceSessionActivity(checkpoint.state, event)
        const nextActivity = deriveSessionActivity(nextState)
        const ts = eventTimestamp(event)
        const transitioned = prevActivity === null || nextActivity !== prevActivity

        checkpoint = {
          cursor: event.seq,
          state: nextState,
          lastTransitionAt: transitioned ? ts : checkpoint.lastTransitionAt || ts,
          lastTransitionSeq: transitioned ? event.seq : checkpoint.lastTransitionSeq || event.seq,
          reported: checkpoint.reported,
        }

        prevActivity = nextActivity
      }

      const activity = deriveSessionActivity(checkpoint.state)
      const lastEvent = events.at(-1)
      const latestTs = lastEvent ? eventTimestamp(lastEvent) : checkpoint.lastTransitionAt
      const activityChanged = checkpoint.reported?.activity !== activity

      const heartbeatDue =
        activity === 'working' &&
        checkpoint.reported !== null &&
        latestTs - checkpoint.reported.at >= WORKING_HEARTBEAT_MS

      if (!activityChanged && !heartbeatDue) {
        await saveCheckpoint(checkpoint)
        return
      }

      const reportAt = activityChanged ? checkpoint.lastTransitionAt || latestTs : latestTs

      const reportSeq = activityChanged
        ? checkpoint.lastTransitionSeq || checkpoint.cursor
        : checkpoint.cursor

      const stub = loomsStub(env.LOOMS_RUN, workspaceId)

      const built = reportActivity({
        runId,
        activity,
        at: reportAt,
      })

      await stub.signal([
        {
          ...built,
          idempotencyKey: `activity:${runId}:${reportSeq}`,
        },
      ])

      await saveCheckpoint({
        ...checkpoint,
        reported: { activity, at: reportAt },
      })
    },
  }
}

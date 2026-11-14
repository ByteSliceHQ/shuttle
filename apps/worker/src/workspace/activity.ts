import { readRunLaunchSource, type EventEnvelope } from '@swirls/looms/core'
import type { Projector } from '@swirls/looms/projectors'

import { workspaceRunId } from '../config'
import type { ShuttleEnv } from '../env'
import { runKindFor } from '../firehose/run-kind'
import { jsonObject } from '../json'
import { loomsStub } from '../looms-stub'
import { readSandboxBinding } from '../session/bind-sandbox'
import { saveSessionWork } from '../session/handoff'
import { readSessionAccess } from '../tenancy/access'
import { listingRunIds } from '../tenancy/listings'
import { orgOfRun } from '../tenancy/run-id'
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
 * Push session activity to the workspace runs that list the session, so the sidebar can show
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
  const orgId = orgOfRun(runId)
  let member: boolean | undefined
  let cachedCheckpoint: ActivityCheckpoint | undefined

  async function launchedByWorkspace(events: ReadonlyArray<EventEnvelope>): Promise<boolean> {
    const started = events.find((event) => event.type === 'runtime.run.started')

    if (started) {
      const { launchedBy } = jsonObject(started.payload)
      // An organization's workspace or a person's own may have launched it.
      const launcher = readRunLaunchSource(launchedBy)?.runId

      member =
        launcher !== undefined &&
        orgOfRun(launcher) === orgId &&
        runKindFor(env, launcher) === 'workspace'

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
      if (runKindFor(env, runId) !== 'session' || events.length === 0) {
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

      // Read each time: the session may have been shared or made public since the last report.
      const access = storage ? await readSessionAccess(storage) : null

      const listings = orgId ? listingRunIds(env, orgId, access) : [workspaceRunId(env, null)]

      const built = reportActivity({
        runId,
        activity,
        at: reportAt,
        seq: reportSeq,
      })

      await Promise.all(
        listings.map((workspaceId) =>
          loomsStub(env.LOOMS_RUN, workspaceId).signal([
            {
              ...built,
              idempotencyKey: `activity:${runId}:${reportSeq}`,
            },
          ]),
        ),
      )

      await saveCheckpoint({
        ...checkpoint,
        reported: { activity, at: reportAt },
      })

      // The session just stopped working: save what it did. Not awaited, so a slow or failing
      // save never holds up the session's own events.
      if (activityChanged && activity !== 'working' && storage) {
        void readSandboxBinding(storage, runId)
          .then((binding) => saveSessionWork(env, storage, runId, binding?.repos ?? []))
          .catch((cause: unknown) => {
            console.warn("could not save the session's work", cause)
          })
      }
    },
  }
}

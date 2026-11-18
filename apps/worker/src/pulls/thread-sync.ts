import { Schema } from 'effect'

import { pullsRunId } from '../config'
import type { ShuttleEnv } from '../env'
import { listPullThreads, type PullThreadSnapshot } from '../github/pulls'
import { loomsStub } from '../looms-stub'
import type { LinkedRepo } from '../workspace/scope'
import { pullKey } from './scope'
import { syncThreads } from './signals'
import { PullThreadsStateSchema } from './threads'

/**
 * Brings the mirror of a pull request's review threads up to date with GitHub. Webhooks keep it
 * current comment by comment, but deliveries get lost and a pull request that was open before
 * Shuttle was connected has threads no webhook ever announced, so the whole set is fetched when
 * someone looks at it. Nothing is recorded when the fetched copy matches what is already known.
 */

/** What two copies are compared on: everything a person would see change. */
const shape = (threads: readonly PullThreadSnapshot[]) =>
  JSON.stringify(
    threads
      .map((thread) => ({
        rootId: thread.rootId,
        resolved: thread.resolved,
        comments: thread.comments
          .map((comment) => [
            comment.commentId,
            comment.updatedAt,
            comment.line,
            comment.outdated,
            comment.body,
          ])
          .toSorted((a, b) => Number(a[0]) - Number(b[0])),
      }))
      .toSorted((a, b) => a.rootId - b.rootId),
  )

/** Whether two copies of a pull request's threads say the same thing. */
export function sameThreads(
  known: readonly PullThreadSnapshot[] | undefined,
  fetched: readonly PullThreadSnapshot[],
): boolean {
  return shape(known ?? []) === shape(fetched)
}

const ProjectionBodySchema = Schema.Struct({ value: Schema.optional(PullThreadsStateSchema) })

async function knownThreads(
  env: ShuttleEnv,
  runId: string,
  key: string,
): Promise<readonly PullThreadSnapshot[] | undefined> {
  const response = await loomsStub(env.LOOMS_RUN, runId).fetch(
    new Request(`https://shuttle.internal/runs/${runId}/projections/pullThreads`, {
      method: 'GET',
    }),
  )

  if (!response.ok) {
    return undefined
  }

  const body = Schema.decodeUnknownSync(ProjectionBodySchema)(await response.json())

  return body.value?.pulls[key]
}

export async function syncPullThreads(
  env: ShuttleEnv,
  orgId: string,
  repo: LinkedRepo,
  number: number,
  now = Date.now(),
): Promise<{ threads: number; changed: boolean }> {
  const runId = pullsRunId(env, orgId)

  const [fetched, known] = await Promise.all([
    listPullThreads(env, repo, number),
    knownThreads(env, runId, pullKey(repo.fullName, number)),
  ])

  if (sameThreads(known, fetched)) {
    return { threads: fetched.length, changed: false }
  }

  await loomsStub(env.LOOMS_RUN, runId).signal([
    syncThreads({ fullName: repo.fullName, number, syncedAt: now, threads: fetched }),
  ])

  return { threads: fetched.length, changed: true }
}

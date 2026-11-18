import { ORPCError } from '@orpc/client'
import { z } from 'zod'

import type { PullComment, PullThread, PullThreadsState } from '@shuttle/core/pulls'
import { defineProjection } from '@swirls/looms/core'

import { type ShuttleHost } from '../../shuttle'
import { isNamespaceEvent } from '../events/namespace-events'
import type { PullsEvent } from '../events/shuttle-events'
import { pullKey } from './pulls'

/**
 * The review threads on each pull request, mirrored from GitHub. The worker owns the events and
 * keeps the same projection (`pulls/threads.ts`); this is its copy for the browser.
 */

export type { PullComment, PullThread, PullThreadsState }

function byAge(a: PullComment, b: PullComment): number {
  const byTime = a.createdAt - b.createdAt

  return byTime === 0 ? a.commentId - b.commentId : byTime
}

function withComment(threads: readonly PullThread[], comment: PullComment): readonly PullThread[] {
  const thread = threads.find((item) => item.rootId === comment.rootId)

  if (!thread) {
    return [...threads, { rootId: comment.rootId, resolved: false, comments: [comment] }]
  }

  const known = thread.comments.find((item) => item.commentId === comment.commentId)

  if (known && known.updatedAt > comment.updatedAt) {
    return threads
  }

  const comments = [
    ...thread.comments.filter((item) => item.commentId !== comment.commentId),
    comment,
  ].toSorted(byAge)

  return threads.map((item) => (item === thread ? { ...thread, comments } : item))
}

function withoutComment(threads: readonly PullThread[], commentId: number): readonly PullThread[] {
  return threads.flatMap((thread) => {
    if (!thread.comments.some((comment) => comment.commentId === commentId)) {
      return [thread]
    }

    if (thread.rootId === commentId) {
      return []
    }

    return [
      { ...thread, comments: thread.comments.filter((comment) => comment.commentId !== commentId) },
    ]
  })
}

export const pullThreads = defineProjection<PullThreadsState, PullsEvent>({
  name: 'pullThreads',
  initialState: { pulls: {} },
  reduce(state, event): PullThreadsState {
    if (!isNamespaceEvent(event, 'pulls')) {
      return state
    }

    switch (event.type) {
      case 'pulls.comment.upserted': {
        const key = pullKey(event.payload.fullName, event.payload.number)
        const threads = state.pulls[key] ?? []
        const next = withComment(threads, event.payload.comment)

        return next === threads ? state : { pulls: { ...state.pulls, [key]: next } }
      }

      case 'pulls.comment.removed': {
        const key = pullKey(event.payload.fullName, event.payload.number)
        const threads = state.pulls[key]

        return threads
          ? { pulls: { ...state.pulls, [key]: withoutComment(threads, event.payload.commentId) } }
          : state
      }

      case 'pulls.thread.resolution': {
        const key = pullKey(event.payload.fullName, event.payload.number)
        const threads = state.pulls[key]

        if (!threads) {
          return state
        }

        return {
          pulls: {
            ...state.pulls,
            [key]: threads.map((thread) =>
              thread.rootId === event.payload.rootId
                ? { ...thread, resolved: event.payload.resolved }
                : thread,
            ),
          },
        }
      }

      case 'pulls.threads.synced': {
        const key = pullKey(event.payload.fullName, event.payload.number)

        return {
          pulls: {
            ...state.pulls,
            [key]: event.payload.threads.map((thread) => ({
              rootId: thread.rootId,
              resolved: thread.resolved,
              comments: thread.comments.toSorted(byAge),
            })),
          },
        }
      }

      case 'pulls.pull.upserted':
      case 'pulls.pull.closed':
      case 'pulls.pull.linked':
      case 'pulls.checks.updated':
      case 'pulls.review.requested':
      case 'pulls.review.submitted':
      case 'pulls.repo.policy.set':
        return state
    }
  },
})

/** Asks the worker to fetch a pull request's threads from GitHub into the mirror. */
export function syncPullThreads(
  host: ShuttleHost,
  folderId: string,
  fullName: string,
  number: number,
): Promise<{ threads: number; changed: boolean }> {
  return host.client.workspace.pulls.syncThreads({ folderId, fullName, number })
}

/** The person has no GitHub account connected, so nothing can be posted as them yet. */
export class GithubNotConnectedError extends Error {
  constructor(message = 'Connect your GitHub account so this can be posted as you.') {
    super(message)
    this.name = 'GithubNotConnectedError'
  }
}

/** The reason the Worker gives when it refuses to act as a person who has not connected GitHub. */
const GITHUB_NOT_CONNECTED = 'github_not_connected'

/** The parts of a refusal's data that can carry the reason or the sentence for people. */
const RefusalData = z.object({
  error: z.string().optional().catch(undefined),
  code: z.string().optional().catch(undefined),
  message: z.string().optional().catch(undefined),
})

/**
 * Turns the Worker's "GitHub is not connected" refusal into the error the comment box knows how
 * to offer a way out of. The Worker answers 409 with the reason as the error's message and the
 * sentence for people in its data. An answer that carries the reason in its data instead, as
 * `error` or `code`, is read the same way. Anything else is handed back as it came.
 */
export function asGithubNotConnected<Cause>(cause: Cause): Cause | GithubNotConnectedError {
  if (!(cause instanceof ORPCError) || cause.status !== 409) {
    return cause
  }

  const found = RefusalData.safeParse(cause.data).data
  const reasons = [cause.message, found?.error, found?.code]

  if (!reasons.includes(GITHUB_NOT_CONNECTED)) {
    return cause
  }

  const sentence = found?.message

  return new GithubNotConnectedError(
    sentence !== undefined && sentence !== '' && sentence !== GITHUB_NOT_CONNECTED
      ? sentence
      : undefined,
  )
}

/** Where a comment goes: under a thread, or on a line of the diff to start one. */
export type CommentTarget =
  | { readonly rootId: number }
  | {
      readonly path: string
      readonly line: number
      readonly side: 'LEFT' | 'RIGHT'
      /** For a comment about several lines: where they start. `line` is where they end. */
      readonly startLine?: number
      readonly startSide?: 'LEFT' | 'RIGHT'
    }

/** Posts a comment on the pull request as the signed-in person. */
export async function postPullComment(
  host: ShuttleHost,
  folderId: string,
  fullName: string,
  number: number,
  target: CommentTarget,
  body: string,
): Promise<void> {
  try {
    await host.client.workspace.pulls.comment({ folderId, fullName, number, ...target, body })
  } catch (cause) {
    throw asGithubNotConnected(cause)
  }
}

/** Resolves or reopens a thread on the pull request as the signed-in person. */
export async function setPullThreadResolved(
  host: ShuttleHost,
  folderId: string,
  fullName: string,
  number: number,
  rootId: number,
  resolved: boolean,
): Promise<void> {
  try {
    await host.client.workspace.pulls.resolveThread({
      folderId,
      fullName,
      number,
      rootId,
      resolved,
    })
  } catch (cause) {
    throw asGithubNotConnected(cause)
  }
}

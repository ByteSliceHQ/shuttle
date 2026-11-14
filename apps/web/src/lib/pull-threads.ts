import type { PullComment, PullThread, PullThreadsState } from '@worker/pulls/threads'

import { defineProjection } from '@swirls/looms/core'

import { pullKey } from './pulls'
import type { PullsEvent } from './shuttle-events'

/**
 * The review threads on each pull request, mirrored from GitHub. The worker owns the events and
 * keeps the same projection (`pulls/threads.ts`); this is its copy for the browser.
 */

export type { PullComment, PullThread, PullThreadsState }

const byAge = (a: PullComment, b: PullComment) =>
  a.createdAt - b.createdAt || a.commentId - b.commentId

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

      default:
        return state
    }
  },
})

/** Asks the worker to fetch a pull request's threads from GitHub into the mirror. */
export async function syncPullThreads(
  folderId: string,
  fullName: string,
  number: number,
): Promise<{ threads: number; changed: boolean }> {
  const response = await fetch(
    `/workspace/folders/${encodeURIComponent(folderId)}/pulls/${encodeURIComponent(fullName)}/${number}/threads/sync`,
    { method: 'POST' },
  )

  const body = (await response.json().catch(() => ({}))) as {
    threads?: number
    changed?: boolean
    error?: string
  }

  if (!response.ok) {
    throw new Error(body.error ?? `GitHub threads could not be read (${response.status})`)
  }

  return { threads: body.threads ?? 0, changed: body.changed ?? false }
}

/** The person has no GitHub account connected, so nothing can be posted as them yet. */
export class GithubNotConnectedError extends Error {
  constructor() {
    super('Connect your GitHub account so this can be posted as you.')
    this.name = 'GithubNotConnectedError'
  }
}

async function asPerson(path: string, payload: Record<string, unknown>): Promise<void> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (response.ok) {
    return
  }

  const body = (await response.json().catch(() => ({}))) as { error?: string }

  if (response.status === 409 && body.error === 'github_not_connected') {
    throw new GithubNotConnectedError()
  }

  throw new Error(body.error ?? `GitHub did not accept that (${response.status})`)
}

const pullPath = (folderId: string, fullName: string, number: number) =>
  `/workspace/folders/${encodeURIComponent(folderId)}/pulls/${encodeURIComponent(fullName)}/${number}`

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
export function postPullComment(
  folderId: string,
  fullName: string,
  number: number,
  target: CommentTarget,
  body: string,
): Promise<void> {
  return asPerson(`${pullPath(folderId, fullName, number)}/comments`, { ...target, body })
}

/** Resolves or reopens a thread on the pull request as the signed-in person. */
export function setPullThreadResolved(
  folderId: string,
  fullName: string,
  number: number,
  rootId: number,
  resolved: boolean,
): Promise<void> {
  return asPerson(`${pullPath(folderId, fullName, number)}/threads/${rootId}/resolution`, {
    resolved,
  })
}

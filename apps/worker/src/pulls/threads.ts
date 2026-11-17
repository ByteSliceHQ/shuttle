import { Schema } from 'effect'

import {
  PullCommentSchema,
  pullKey,
  pullsModule,
  type PullComment,
  type PullThread,
  type PullThreadsState,
} from './scope'

export type { PullComment, PullThread, PullThreadsState }

/**
 * The review threads on each pull request, mirrored from GitHub: comments arrive one at a time
 * from webhooks, and a full copy of a pull request's threads replaces what was known whenever
 * one is fetched. A thread is its first comment and the replies to it.
 */

const byAge = (a: PullComment, b: PullComment) =>
  a.createdAt - b.createdAt || a.commentId - b.commentId

function withComment(threads: readonly PullThread[], comment: PullComment): readonly PullThread[] {
  const thread = threads.find((item) => item.rootId === comment.rootId)

  if (!thread) {
    return [...threads, { rootId: comment.rootId, resolved: false, comments: [comment] }]
  }

  const known = thread.comments.find((item) => item.commentId === comment.commentId)

  // Deliveries can arrive out of order; an older copy never replaces a newer one.
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

    // GitHub deletes a thread's replies along with the comment that started it.
    if (thread.rootId === commentId) {
      return []
    }

    return [
      { ...thread, comments: thread.comments.filter((comment) => comment.commentId !== commentId) },
    ]
  })
}

const PullThreadSchema = Schema.Struct({
  rootId: Schema.Finite,
  resolved: Schema.Boolean,
  comments: Schema.Array(PullCommentSchema),
})

export const pullThreads = pullsModule.projection({
  name: 'pullThreads',
  shape: Schema.Struct({ pulls: Schema.Record(Schema.String, Schema.Array(PullThreadSchema)) }),
  initialState: { pulls: {} } satisfies PullThreadsState,
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

      case 'pulls.pull.closed': {
        const key = pullKey(event.payload.fullName, event.payload.number)

        if (!state.pulls[key]) {
          return state
        }

        const { [key]: _closed, ...pulls } = state.pulls

        return { pulls }
      }

      default:
        return state
    }
  },
})

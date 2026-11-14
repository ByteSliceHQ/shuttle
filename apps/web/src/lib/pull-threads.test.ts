import { describe, expect, test } from 'bun:test'

import { pullThreads, type PullComment } from './pull-threads'

const comment = (commentId: number, rootId = commentId): PullComment => ({
  commentId,
  rootId,
  path: 'app.js',
  line: 12,
  side: 'RIGHT',
  outdated: false,
  body: `comment ${commentId}`,
  author: { login: 'dylan', avatarUrl: '' },
  createdAt: commentId,
  updatedAt: commentId,
  url: '',
})

const fold = (events: readonly { type: string; payload: unknown }[]) =>
  events.reduce(
    (state, event) => pullThreads.reduce(state, event as never),
    pullThreads.initialState,
  )

describe('pullThreads in the browser', () => {
  test('builds threads from comments, then takes a full copy from GitHub over them', () => {
    const pull = { fullName: 'acme/glue', number: 8 }

    const built = fold([
      { type: 'pulls.comment.upserted', payload: { ...pull, comment: comment(2, 1) } },
      { type: 'pulls.comment.upserted', payload: { ...pull, comment: comment(1) } },
      {
        type: 'pulls.thread.resolution',
        payload: { ...pull, rootId: 1, resolved: true, updatedAt: 9 },
      },
    ])

    expect(built.pulls['acme/glue#8']).toEqual([
      { rootId: 1, resolved: true, comments: [comment(1), comment(2, 1)] },
    ])

    const synced = pullThreads.reduce(built, {
      type: 'pulls.threads.synced',
      payload: { ...pull, syncedAt: 10, threads: [] },
    } as never)

    expect(synced.pulls['acme/glue#8']).toEqual([])
  })
})

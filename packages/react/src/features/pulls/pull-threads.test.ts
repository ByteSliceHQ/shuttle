import { describe, expect, test } from 'bun:test'

import { ORPCError } from '@orpc/client'

import {
  asGithubNotConnected,
  GithubNotConnectedError,
  pullThreads,
  type PullComment,
} from './pull-threads'

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

describe('asGithubNotConnected', () => {
  test('reads the reason from the message and the sentence from the data', () => {
    const error = asGithubNotConnected(
      new ORPCError('CONFLICT', {
        status: 409,
        message: 'github_not_connected',
        data: { message: 'Connect your GitHub account first.' },
      }),
    )

    expect(error).toBeInstanceOf(GithubNotConnectedError)
    expect(error).toHaveProperty('message', 'Connect your GitHub account first.')
  })

  test('reads the reason from the data, and falls back to its own sentence', () => {
    const error = asGithubNotConnected(
      new ORPCError('CONFLICT', { status: 409, data: { error: 'github_not_connected' } }),
    )

    expect(error).toBeInstanceOf(GithubNotConnectedError)

    expect(error).toHaveProperty(
      'message',
      'Connect your GitHub account so this can be posted as you.',
    )
  })

  test('leaves other conflicts, other statuses and other errors as they came', () => {
    const conflict = new ORPCError('CONFLICT', { status: 409, message: 'thread is outdated' })

    const elsewhere = new ORPCError('BAD_GATEWAY', {
      status: 502,
      message: 'github_not_connected',
    })

    const plain = new Error('github_not_connected')

    expect(asGithubNotConnected(conflict)).toBe(conflict)
    expect(asGithubNotConnected(elsewhere)).toBe(elsewhere)
    expect(asGithubNotConnected(plain)).toBe(plain)
  })
})

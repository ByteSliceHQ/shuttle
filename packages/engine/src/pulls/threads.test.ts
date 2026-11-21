import { describe, expect, test } from 'bun:test'

import { threadSnapshot } from '@shuttle/git/github/pulls'
import { createEvent } from '@swirls/looms/core'

import { pullsModule } from './scope'
import { sameThreads } from './thread-sync'
import { pullThreads, type PullComment, type PullThreadsState } from './threads'

const PULL = { fullName: 'acme/glue', number: 8 }
const KEY = 'acme/glue#8'

const comment = (commentId: number, overrides: Partial<PullComment> = {}): PullComment => ({
  commentId,
  rootId: commentId,
  path: 'app.js',
  line: 12,
  side: 'RIGHT',
  outdated: false,
  body: `comment ${commentId}`,
  author: { login: 'dylan', avatarUrl: '' },
  createdAt: commentId,
  updatedAt: commentId,
  url: `https://github.com/acme/glue/pull/8#discussion_r${commentId}`,
  ...overrides,
})

type ThreadEvent = Parameters<typeof pullThreads.reduce>[1]

const fold = (events: readonly ThreadEvent[]): PullThreadsState =>
  events.reduce((state, event) => pullThreads.reduce(state, event), pullThreads.initialState)

const upserted = (value: PullComment) =>
  createEvent('run_test', pullsModule.input('comment.upserted', { ...PULL, comment: value }))

const removed = (commentId: number) =>
  createEvent('run_test', pullsModule.input('comment.removed', { ...PULL, commentId }))

const resolution = (resolved: boolean) =>
  createEvent(
    'run_test',
    pullsModule.input('thread.resolution', { ...PULL, rootId: 1, resolved, updatedAt: 50 }),
  )

const threadOf = (body: string) => [
  { rootId: 1, resolved: false, comments: [comment(1, { body })] },
]

describe('pullThreads projection', () => {
  test('a reply joins the thread of the comment it answers, oldest first', () => {
    const state = fold([
      upserted(comment(3, { rootId: 1 })),
      upserted(comment(1)),
      upserted(comment(2, { rootId: 1 })),
      upserted(comment(5)),
    ])

    expect(state.pulls[KEY]?.map((thread) => thread.rootId)).toEqual([1, 5])
    expect(state.pulls[KEY]?.[0]?.comments.map((item) => item.commentId)).toEqual([1, 2, 3])
  })

  test('an edit replaces the comment, and an older copy arriving late does not', () => {
    const state = fold([
      upserted(comment(1, { body: 'first', updatedAt: 10 })),
      upserted(comment(1, { body: 'edited', updatedAt: 20 })),
      upserted(comment(1, { body: 'first', updatedAt: 10 })),
    ])

    expect(state.pulls[KEY]?.[0]?.comments).toHaveLength(1)
    expect(state.pulls[KEY]?.[0]?.comments[0]?.body).toBe('edited')
  })

  test('deleting a reply keeps the thread; deleting its first comment removes it', () => {
    const base = [upserted(comment(1)), upserted(comment(2, { rootId: 1 }))]

    expect(fold([...base, removed(2)]).pulls[KEY]?.[0]?.comments).toHaveLength(1)
    expect(fold([...base, removed(1)]).pulls[KEY]).toEqual([])
  })

  test('a thread is resolved and reopened', () => {
    expect(fold([upserted(comment(1)), resolution(true)]).pulls[KEY]?.[0]?.resolved).toBe(true)

    expect(
      fold([upserted(comment(1)), resolution(true), resolution(false)]).pulls[KEY]?.[0]?.resolved,
    ).toBe(false)
  })

  test('a full copy from GitHub replaces what webhooks had built up', () => {
    const state = fold([
      upserted(comment(1)),
      upserted(comment(9)),
      createEvent(
        'run_test',
        pullsModule.input('threads.synced', {
          ...PULL,
          syncedAt: 100,
          threads: [
            { rootId: 1, resolved: true, comments: [comment(2, { rootId: 1 }), comment(1)] },
          ],
        }),
      ),
    ])

    expect(state.pulls[KEY]).toHaveLength(1)
    expect(state.pulls[KEY]?.[0]?.resolved).toBe(true)
    expect(state.pulls[KEY]?.[0]?.comments.map((item) => item.commentId)).toEqual([1, 2])
  })
})

describe('sameThreads', () => {
  test('nothing known and nothing on GitHub is no change', () => {
    expect(sameThreads(undefined, [])).toBe(true)
  })

  test('an edited comment, a new one or a resolution is a change', () => {
    expect(sameThreads(threadOf('a'), threadOf('a'))).toBe(true)
    expect(sameThreads(threadOf('a'), threadOf('b'))).toBe(false)
    expect(sameThreads(threadOf('a'), [])).toBe(false)

    expect(sameThreads(threadOf('a'), [{ ...threadOf('a')[0]!, resolved: true }])).toBe(false)
  })
})

describe('threadSnapshot', () => {
  const node = {
    isResolved: true,
    isOutdated: true,
    path: 'app.js',
    line: null,
    originalLine: 40,
    startLine: null,
    originalStartLine: 38,
    diffSide: 'RIGHT' as const,
    comments: {
      nodes: [
        {
          fullDatabaseId: '2987654321',
          body: 'Why?',
          url: 'https://github.com/acme/glue/pull/8#discussion_r2987654321',
          createdAt: '2026-11-14T10:00:00Z',
          updatedAt: '2026-11-14T10:05:00Z',
          author: null,
        },
      ],
    },
  }

  test('keeps ids past 32 bits, and where an outdated thread used to sit', () => {
    const snapshot = threadSnapshot(node)

    expect(snapshot?.rootId).toBe(2_987_654_321)
    expect(snapshot?.resolved).toBe(true)

    expect(snapshot?.comments[0]).toMatchObject({
      line: 40,
      startLine: 38,
      outdated: true,
      author: { login: 'unknown' },
    })
  })

  test('a thread with no comments is left out', () => {
    expect(threadSnapshot({ ...node, comments: { nodes: [] } })).toBeNull()
  })
})

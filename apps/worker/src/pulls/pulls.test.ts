import { describe, expect, test } from 'bun:test'

import { pullInbox, withLinkedSession } from './projections'
import { pullKey } from './scope'
import { reviewerLinked } from './signals'

describe('pullInbox projection', () => {
  test('upserts pulls and drops stale updates', () => {
    let state = pullInbox.initialState

    state = pullInbox.reduce(state, {
      type: 'pulls.pull.upserted',
      payload: {
        installationId: 1,
        fullName: 'acme/api',
        number: 7,
        action: 'opened',
        title: 'First',
        body: '',
        url: 'https://github.com/acme/api/pull/7',
        draft: false,
        author: { login: 'dylan', avatarUrl: '' },
        headRef: 'feature',
        headSha: 'aaa',
        baseRef: 'main',
        baseSha: 'bbb',
        additions: 1,
        deletions: 0,
        reviewDecision: 'none',
        checkRollup: 'pending',
        updatedAt: 100,
        isFork: false,
        state: 'open',
      },
    } as never)

    expect(state.pulls[pullKey('acme/api', 7)]?.title).toBe('First')

    state = pullInbox.reduce(state, {
      type: 'pulls.pull.upserted',
      payload: {
        installationId: 1,
        fullName: 'acme/api',
        number: 7,
        action: 'edited',
        title: 'Stale',
        body: '',
        url: 'https://github.com/acme/api/pull/7',
        draft: false,
        author: { login: 'dylan', avatarUrl: '' },
        headRef: 'feature',
        headSha: 'aaa',
        baseRef: 'main',
        baseSha: 'bbb',
        additions: 1,
        deletions: 0,
        reviewDecision: 'none',
        checkRollup: 'pending',
        updatedAt: 50,
        isFork: false,
        state: 'open',
      },
    } as never)

    expect(state.pulls[pullKey('acme/api', 7)]?.title).toBe('First')

    state = pullInbox.reduce(state, {
      type: 'pulls.pull.linked',
      payload: {
        fullName: 'acme/api',
        number: 7,
        runId: 'run_1',
        role: 'author',
      },
    } as never)

    expect(state.pulls[pullKey('acme/api', 7)]?.linkedSessions).toEqual([
      { runId: 'run_1', role: 'author' },
    ])

    state = pullInbox.reduce(state, {
      type: 'pulls.pull.linked',
      payload: {
        fullName: 'acme/api',
        number: 7,
        runId: 'run_1',
        role: 'author',
        threadId: 'thread_coder',
      },
    } as never)

    expect(state.pulls[pullKey('acme/api', 7)]?.linkedSessions).toEqual([
      { runId: 'run_1', role: 'author', threadId: 'thread_coder' },
    ])
  })
})

describe('withLinkedSession', () => {
  test('appends a new session link with its thread', () => {
    expect(withLinkedSession([], { runId: 'run_1', role: 'author', threadId: 'thread_a' })).toEqual(
      [{ runId: 'run_1', role: 'author', threadId: 'thread_a' }],
    )
  })

  test('keeps one link per session and role', () => {
    const linked = [{ runId: 'run_1', role: 'author' as const, threadId: 'thread_a' }]

    expect(withLinkedSession(linked, { runId: 'run_1', role: 'author' })).toBe(linked)

    expect(
      withLinkedSession(linked, { runId: 'run_1', role: 'author', threadId: 'thread_a' }),
    ).toBe(linked)

    expect(withLinkedSession(linked, { runId: 'run_1', role: 'reviewer' })).toEqual([
      ...linked,
      { runId: 'run_1', role: 'reviewer' },
    ])
  })

  test('the latest thread wins for an existing link', () => {
    expect(
      withLinkedSession([{ runId: 'run_1', role: 'author', threadId: 'thread_a' }], {
        runId: 'run_1',
        role: 'author',
        threadId: 'thread_b',
      }),
    ).toEqual([{ runId: 'run_1', role: 'author', threadId: 'thread_b' }])
  })
})

describe('linkReviewSession', () => {
  test('links the session as a reviewer, once per session and pull request', () => {
    const input = { fullName: 'acme/glue', number: 8, runId: 'run_review' }
    const first = reviewerLinked(input)

    expect(first.type).toBe('pulls.pull.linked')
    expect(first.payload).toEqual({ ...input, role: 'reviewer' })
    expect(JSON.stringify(reviewerLinked(input))).toBe(JSON.stringify(first))
  })
})

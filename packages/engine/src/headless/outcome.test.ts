import { describe, expect, test } from 'bun:test'

import { emptyRunState, type ThreadRecord } from '@swirls/looms/core'

import { outcomeOf, pullRequestsOf, questionOf, sessionOutcome } from './outcome'

const published = {
  stacks: {
    'a/b': {
      layers: [
        { layer: 1, pull: { number: 7, url: 'https://github.com/a/b/pull/7', draft: true } },
        { layer: 2, pull: null },
      ],
    },
    'a/b#2': {
      layers: [
        { layer: 1, pull: { number: 9, url: 'https://github.com/a/b/pull/9', draft: false } },
      ],
    },
  },
}

describe('pullRequestsOf', () => {
  test('lists every published layer with its repository, across stacks', () => {
    expect(pullRequestsOf(published)).toEqual([
      { repo: 'a/b', number: 7, url: 'https://github.com/a/b/pull/7', draft: true },
      { repo: 'a/b', number: 9, url: 'https://github.com/a/b/pull/9', draft: false },
    ])
  })

  test('is empty for a session that has published nothing', () => {
    expect(pullRequestsOf({})).toEqual([])
  })
})

describe('questionOf', () => {
  test('is the question an agent asked', () => {
    expect(
      questionOf({
        state: {},
        asked: [{ approvalId: 'ask_1', title: 'Which database?', description: null }],
      }),
    ).toEqual({
      approvalId: 'ask_1',
      title: 'Which database?',
      description: null,
      kind: 'question',
      expiresAt: null,
    })
  })

  test('a pull request proposal says so, and when it stops taking a decision', () => {
    expect(
      questionOf({
        state: {
          pendingPrPublish: {
            approvalId: 'pr_publish_1',
            title: 'Fix the test',
            status: 'awaiting_approval',
            expiresAt: 5_000,
          },
        },
        asked: [{ approvalId: 'ask_1', title: 'Which database?', description: null }],
      }),
    ).toEqual({
      approvalId: 'pr_publish_1',
      title: 'Publish this pull request?',
      description: 'Fix the test',
      kind: 'publish-pull-request',
      expiresAt: 5_000,
    })
  })

  test('a proposal that is already publishing is no longer a question', () => {
    expect(
      questionOf({
        state: { pendingPrPublish: { approvalId: 'pr_publish_1', status: 'publishing' } },
      }),
    ).toBeNull()
  })

  test('is null when nothing is open', () => {
    expect(questionOf({ state: {} })).toBeNull()
  })
})

describe('outcomeOf', () => {
  test('a session still at work has nothing to report', () => {
    expect(outcomeOf({ activity: 'working', state: published })).toEqual({ state: 'working' })
  })

  test('an idle session has completed, with its pull requests', () => {
    const outcome = outcomeOf({ activity: 'idle', state: published })

    expect(outcome.state).toBe('completed')
    expect('pullRequests' in outcome && outcome.pullRequests).toHaveLength(2)
  })

  test('a session waiting on a person is blocked on the question', () => {
    const outcome = outcomeOf({
      activity: 'needs_input',
      state: {},
      asked: [{ approvalId: 'ask_1', title: 'Which database?', description: null }],
    })

    expect(outcome).toEqual({
      state: 'blocked',
      question: {
        approvalId: 'ask_1',
        title: 'Which database?',
        description: null,
        kind: 'question',
        expiresAt: null,
      },
      pullRequests: [],
    })
  })

  test('a review an agent asks to submit is a decision, not a question', () => {
    const outcome = outcomeOf({
      activity: 'needs_input',
      state: {},
      asked: [
        { approvalId: 'pr_review_1', title: 'Submit pull request review?', description: null },
      ],
    })

    expect(outcome).toMatchObject({
      state: 'blocked',
      question: { approvalId: 'pr_review_1', kind: 'submit-review' },
    })
  })

  test('a session waiting on nothing the run can name is blocked with no id to answer', () => {
    expect(outcomeOf({ activity: 'needs_input', state: {} })).toMatchObject({
      state: 'blocked',
      question: { approvalId: null, kind: 'question' },
    })
  })

  test('an open proposal blocks a session that is otherwise at rest or still in a tool call', () => {
    const state = {
      pendingPrPublish: { approvalId: 'pr_publish_1', title: 'Fix', status: 'awaiting_approval' },
    }

    expect(outcomeOf({ activity: 'idle', state }).state).toBe('blocked')
    expect(outcomeOf({ activity: 'working', state }).state).toBe('blocked')
  })

  test('a session that stopped on an error has failed', () => {
    expect(outcomeOf({ activity: 'error', state: { error: { message: 'boom' } } })).toEqual({
      state: 'failed',
      error: 'boom',
      pullRequests: [],
    })
  })
})

const thread = (threadId: string, overrides: Partial<ThreadRecord>): ThreadRecord => ({
  threadId,
  kind: 'agent',
  definitionName: 'agent',
  definitionVersion: '1',
  parentThreadId: null,
  status: 'running',
  input: null,
  output: null,
  error: null,
  state: {},
  ...overrides,
})

describe('sessionOutcome', () => {
  test('a failed run whose root says nothing gives the error of the thread that failed under it', () => {
    const run = {
      ...emptyRunState('session'),
      status: 'failed' as const,
      rootThreadId: 'root',
      threads: {
        root: thread('root', { status: 'failed' }),
        turn: thread('turn', {
          parentThreadId: 'root',
          status: 'failed',
          error: 'This request requires more credits',
        }),
      },
    }

    expect(sessionOutcome(run)).toEqual({
      state: 'failed',
      error: 'This request requires more credits',
      pullRequests: [],
    })
  })
})

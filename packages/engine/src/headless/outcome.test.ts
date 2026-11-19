import { describe, expect, test } from 'bun:test'

import { outcomeOf, pullRequestsOf, questionOf } from './outcome'

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
  test('is the approval the session is waiting on', () => {
    expect(
      questionOf({ openApprovals: { ask_1: { title: 'Which database?', description: null } } }),
    ).toEqual({ approvalId: 'ask_1', title: 'Which database?', description: null })
  })

  test('is null when nothing is open', () => {
    expect(questionOf({ openApprovals: {} })).toBeNull()
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
      state: { openApprovals: { ask_1: { title: 'Which database?', description: 'Two fit.' } } },
    })

    expect(outcome).toEqual({
      state: 'blocked',
      question: { approvalId: 'ask_1', title: 'Which database?', description: 'Two fit.' },
      pullRequests: [],
    })
  })

  test('a session that stopped on an error has failed', () => {
    expect(outcomeOf({ activity: 'error', state: { error: { message: 'boom' } } })).toEqual({
      state: 'failed',
      error: 'boom',
      pullRequests: [],
    })
  })
})

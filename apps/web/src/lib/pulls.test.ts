import { describe, expect, test } from 'bun:test'

import {
  authoredPullCounts,
  groupPullsByLane,
  pullKey,
  reviewedPullForSession,
  stacksOf,
  type InboxEntry,
  type PullInboxState,
  type PullInboxSummary,
} from './pulls'

function pull(
  fullName: string,
  number: number,
  overrides: Partial<PullInboxSummary> = {},
): PullInboxSummary {
  return {
    installationId: 1,
    fullName,
    number,
    title: `${fullName}#${number}`,
    body: '',
    url: '',
    state: 'open',
    draft: false,
    author: { login: 'octocat', avatarUrl: '' },
    headRef: 'feature',
    headSha: 'abc',
    baseRef: 'main',
    baseSha: 'def',
    additions: 1,
    deletions: 0,
    reviewDecision: 'review_required',
    checkRollup: 'pending',
    updatedAt: 0,
    isFork: false,
    stack: null,
    linkedSessions: [],
    reviewingRunId: null,
    ...overrides,
  }
}

const authored = (runId: string) => ({ linkedSessions: [{ runId, role: 'author' as const }] })

function describeEntries(entries: readonly InboxEntry[] | undefined) {
  return (entries ?? []).map((entry) => {
    switch (entry.kind) {
      case 'pull':
        return `${entry.pull.fullName}#${entry.pull.number}`
      case 'changeset':
        return `${entry.sessionRunId}[${entry.pulls.map((p) => p.number).join(',')}]/${entry.total}`
      case 'stack':
        return `stack[${entry.stack.layers.map((p) => p.number).join(',')}]`

      default: {
        const exhaustive: never = entry
        return exhaustive
      }
    }
  })
}

describe('groupPullsByLane', () => {
  test('groups every PR one session opened in the same lane', () => {
    const lanes = groupPullsByLane([
      pull('acme/api', 1, authored('run_a')),
      pull('acme/web', 2),
      pull('acme/web', 3, authored('run_a')),
      pull('acme/infra', 4, authored('run_a')),
    ])

    expect(describeEntries(lanes.get('opened_by_shuttle'))).toEqual(['run_a[1,3,4]/3'])
    expect(describeEntries(lanes.get('needs_review'))).toEqual(['acme/web#2'])
  })

  test('splits a changeset whose PRs landed in different lanes', () => {
    const lanes = groupPullsByLane([
      pull('acme/api', 1, authored('run_a')),
      pull('acme/web', 2, { ...authored('run_a'), draft: true }),
      pull('acme/infra', 3, authored('run_a')),
    ])

    expect(describeEntries(lanes.get('opened_by_shuttle'))).toEqual(['run_a[1,3]/3'])
    expect(describeEntries(lanes.get('drafts'))).toEqual(['acme/web#2'])
  })

  test('keeps a lone authored PR as a plain row', () => {
    const lanes = groupPullsByLane([pull('acme/api', 1, authored('run_a'))])

    expect(describeEntries(lanes.get('opened_by_shuttle'))).toEqual(['acme/api#1'])
  })

  test('keeps separate sessions in separate changesets', () => {
    const lanes = groupPullsByLane([
      pull('acme/api', 1, authored('run_a')),
      pull('acme/api', 2, authored('run_b')),
      pull('acme/web', 3, authored('run_a')),
      pull('acme/web', 4, authored('run_b')),
    ])

    expect(describeEntries(lanes.get('opened_by_shuttle'))).toEqual([
      'run_a[1,3]/2',
      'run_b[2,4]/2',
    ])
  })

  test('prefers a native stack over a changeset group', () => {
    const lanes = groupPullsByLane([
      pull('acme/api', 1, {
        ...authored('run_a'),
        headRef: 'l1',
        baseRef: 'main',
        stack: { number: 9, position: 1, size: 2 },
        draft: true,
      }),
      pull('acme/api', 2, {
        ...authored('run_a'),
        headRef: 'l2',
        baseRef: 'l1',
        stack: { number: 9, position: 2, size: 2 },
      }),
    ])

    expect(describeEntries(lanes.get('drafts'))).toEqual(['stack[1,2]'])
    expect(describeEntries(lanes.get('opened_by_shuttle'))).toEqual(['stack[1,2]'])
  })

  test('keeps a standalone PR out of the stack the same session opened', () => {
    for (const native of [true, false]) {
      const lanes = groupPullsByLane([
        pull('acme/api', 1, {
          ...authored('run_a'),
          headRef: 'shuttle/run_a/api',
          baseRef: 'main',
          stack: native ? { number: 9, position: 1, size: 2 } : null,
        }),
        pull('acme/api', 2, {
          ...authored('run_a'),
          headRef: 'shuttle/run_a-stack/api/2',
          baseRef: 'shuttle/run_a/api',
          stack: native ? { number: 9, position: 2, size: 2 } : null,
        }),
        pull('acme/api', 3, {
          ...authored('run_a'),
          headRef: 'shuttle/run_a-stack2/api/1',
          baseRef: 'main',
        }),
      ])

      expect(describeEntries(lanes.get('opened_by_shuttle'))).toEqual(['stack[1,2]', 'acme/api#3'])
    }
  })
})

describe('authoredPullCounts', () => {
  test('counts open PRs per authoring session, ignoring reviewers and closed PRs', () => {
    const pulls = [
      pull('acme/api', 1, authored('run_a')),
      pull('acme/api', 2, authored('run_a')),
      pull('acme/api', 3, { ...authored('run_a'), state: 'closed' }),
      pull('acme/web', 4, { linkedSessions: [{ runId: 'run_b', role: 'reviewer' as const }] }),
      pull('acme/web', 5, authored('run_c')),
    ]

    const counts = authoredPullCounts({
      pulls: Object.fromEntries(
        pulls.map((entry) => [pullKey(entry.fullName, entry.number), entry]),
      ),
      policies: {},
    })

    expect(Object.fromEntries(counts)).toEqual({ run_a: 2, run_c: 1 })
  })
})

describe('stacksOf', () => {
  test('orders native stack layers by position', () => {
    const stacks = stacksOf([
      pull('acme/api', 2, {
        headRef: 'l2',
        baseRef: 'l1',
        stack: { number: 3, position: 2, size: 2 },
      }),
      pull('acme/api', 1, {
        headRef: 'l1',
        baseRef: 'main',
        stack: { number: 3, position: 1, size: 2 },
      }),
    ])

    expect(stacks).toHaveLength(1)
    expect(stacks[0]?.native).toBe(true)
    expect(stacks[0]?.layers.map((layer) => layer.number)).toEqual([1, 2])
  })

  test('detects a chained non-native stack', () => {
    const stacks = stacksOf([
      pull('acme/api', 1, { headRef: 'bottom', baseRef: 'main' }),
      pull('acme/api', 2, { headRef: 'top', baseRef: 'bottom' }),
    ])

    expect(stacks).toHaveLength(1)
    expect(stacks[0]?.native).toBe(false)
    expect(stacks[0]?.layers.map((layer) => layer.number)).toEqual([1, 2])
  })
})

describe('reviewedPullForSession', () => {
  test('finds the pull request a session is linked to as reviewer, and no other', () => {
    const inbox = {
      pulls: {
        'acme/glue#7': pull('acme/glue', 7, {
          linkedSessions: [{ runId: 'run_a', role: 'author' }],
        }),
        'acme/glue#8': pull('acme/glue', 8, {
          linkedSessions: [{ runId: 'run_a', role: 'reviewer' }],
        }),
      },
    } as unknown as PullInboxState

    expect(reviewedPullForSession(inbox, 'run_a')?.number).toBe(8)
    expect(reviewedPullForSession(inbox, 'run_b')).toBeUndefined()
  })
})

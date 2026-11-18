import { describe, expect, test } from 'bun:test'

import type { PullInboxState, PullInboxSummary } from '../pulls/pulls'
import type { WorkspaceRepo } from './sandbox'
import {
  comparisonTitle,
  pullComparison,
  pullShown,
  pullSync,
  railBrackets,
  railPoints,
  railSpan,
  runPulls,
  shortRef,
  type RunPull,
} from './workspace-comparison'

const RUN = 'o-org-run1'
const LAYER1 = `shuttle/${RUN}/web`
const LAYER2 = `shuttle/${RUN}-stack/web/2`

function pull(number: number, overrides: Partial<PullInboxSummary> = {}): PullInboxSummary {
  return {
    installationId: 1,
    fullName: 'larkspur/web',
    number,
    title: `PR ${number}`,
    body: '',
    url: '',
    state: 'open',
    draft: false,
    author: { login: 'octocat', avatarUrl: '' },
    headRef: LAYER1,
    headSha: 'c1',
    baseRef: 'main',
    baseSha: 'b0',
    additions: 1,
    deletions: 0,
    reviewDecision: 'none',
    checkRollup: 'passing',
    updatedAt: 0,
    isFork: false,
    stack: null,
    linkedSessions: [{ runId: RUN, role: 'author' }],
    reviewingRunId: null,
    ...overrides,
  }
}

/** A session with two stacked layers: c1 on layer 1, c2 on layer 2 (checked out), and uncommitted work. */
function repo(overrides: Partial<WorkspaceRepo> = {}): WorkspaceRepo {
  return {
    name: 'web',
    fullName: 'larkspur/web',
    defaultBranch: 'main',
    files: [],
    changes: [],
    head: { branch: LAYER2, sha: 'c2' },
    dirty: true,
    sessionBaseSha: 'b0',
    commits: [
      { sha: 'c2', subject: 'two', at: 2, branches: [LAYER2] },
      { sha: 'c1', subject: 'one', at: 1, branches: [LAYER1] },
    ],
    comparison: {
      against: 'session',
      baseSha: 'b0',
      baseMode: 'merge-base',
      headSha: null,
      error: null,
    },
    ...overrides,
  }
}

const first: RunPull = { pull: pull(412), role: 'author' }

const second: RunPull = {
  pull: pull(413, { headRef: LAYER2, baseRef: LAYER1, headSha: 'c2' }),
  role: 'author',
}

describe('the session pull requests', () => {
  test('are the ones linked to it, open first', () => {
    const inbox = {
      pulls: {
        a: pull(1, { state: 'closed' }),
        b: pull(2),
        c: pull(3, { linkedSessions: [{ runId: 'other', role: 'author' }] }),
      },
      policies: {},
    } as unknown as PullInboxState

    expect(runPulls(inbox, RUN).map((run) => run.pull.number)).toEqual([2, 1])
  })

  test('a layer below the one checked out is compared commit to commit', () => {
    expect(pullComparison(first, repo())).toBe(`range:main...${LAYER1}`)
  })

  test('the layer checked out is compared to the working tree, so unpushed work shows', () => {
    expect(pullComparison(second, repo())).toBe(`ref:${LAYER1}`)
    expect(pullShown(`ref:${LAYER1}`, [first, second], repo())?.pull.number).toBe(413)
  })

  test('a review compares the way the session already does', () => {
    expect(pullComparison({ pull: pull(9), role: 'reviewer' }, repo())).toBe('session')
  })

  test('say whether GitHub has what the sandbox has', () => {
    expect(pullSync(first.pull, repo())).toBe('pushed')
    expect(pullSync(second.pull, repo())).toBe('uncommitted')
    expect(pullSync(second.pull, repo({ dirty: false }))).toBe('pushed')
    expect(pullSync({ ...first.pull, headSha: 'old' }, repo())).toBe('unpushed')
    expect(pullSync(first.pull, repo({ head: null }))).toBeNull()
  })
})

describe('the rail', () => {
  const points = railPoints(repo())

  test('runs from the start through each commit, oldest first, to the working tree', () => {
    expect(points.map((point) => ('sha' in point ? point.sha : point.kind))).toEqual([
      'b0',
      'c1',
      'c2',
      'worktree',
    ])
  })

  test('lights the stretch a comparison covers', () => {
    expect(railSpan(repo(), points)).toEqual({ from: 0, to: 3 })

    const uncommitted = repo({
      comparison: {
        against: 'uncommitted',
        baseSha: 'c2',
        baseMode: 'merge-base',
        headSha: null,
        error: null,
      },
    })

    expect(railSpan(uncommitted, points)).toEqual({ from: 2, to: 3 })

    const range = repo({
      comparison: {
        against: `range:main...${LAYER1}`,
        baseSha: 'b0',
        baseMode: 'merge-base',
        headSha: 'c1',
        error: null,
      },
    })

    expect(railSpan(range, points)).toEqual({ from: 0, to: 1 })

    const missing = repo({
      comparison: {
        against: 'ref:nowhere',
        baseSha: null,
        baseMode: null,
        headSha: null,
        error: 'gone',
      },
    })

    expect(railSpan(missing, points)).toBeNull()
  })

  test('brackets each pull request over its commits', () => {
    expect(
      railBrackets(repo(), points, [first, second]).map(({ run, from, to }) => [
        run.pull.number,
        from,
        to,
      ]),
    ).toEqual([
      [412, 0, 1],
      [413, 1, 3],
    ])
  })
})

describe('naming a comparison', () => {
  test('says what is being looked at', () => {
    expect(comparisonTitle('session', repo(), [])).toBe('All changes in this session')
    expect(comparisonTitle('uncommitted', repo(), [])).toBe('Uncommitted changes')
    expect(comparisonTitle('ref:c1', repo(), [])).toBe('Since c1')
    expect(comparisonTitle('ref:develop', repo(), [])).toBe('Compared with develop')
    expect(comparisonTitle(`range:main...${LAYER1}`, repo(), [first])).toBe('PR #412')
  })
})

describe('shortRef', () => {
  test('a short name is shown whole', () => {
    expect(shortRef('main')).toBe('main')
    expect(shortRef('feat/workspace-comparisons')).toBe('feat/workspace-comparisons')
  })

  test('a long name loses its middle, at separators', () => {
    expect(
      shortRef(
        'shuttle/o-FsKae0UJqpFRGprFk4tV0C6EkWxThciR-session_7e100ff7-6866-462b-935c-a253d1eb3a15-stack2/demo/1',
      ),
    ).toBe('shuttle/o-…-stack2/demo/1')

    expect(
      shortRef(
        'shuttle/o-FsKae0UJqpFRGprFk4tV0C6EkWxThciR-session_7e100ff7-6866-462b-935c-a253d1eb3a15/demo',
      ),
    ).toBe('shuttle/o-…/demo')
  })

  test('a long name with no separators keeps its first and last characters', () => {
    expect(shortRef('a'.repeat(20) + 'b'.repeat(20))).toBe(`${'a'.repeat(12)}…${'b'.repeat(16)}`)
  })
})

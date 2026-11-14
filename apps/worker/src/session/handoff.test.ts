import { describe, expect, test } from 'bun:test'

import type { ShuttleEnv } from '../env'
import { userSandboxName } from '../sandbox/names'
import type { SessionSnapshot } from '../sandbox/session-sync'
import { ACCESS_STORAGE_KEY } from '../tenancy/access'
import { scopedRunId } from '../tenancy/run-id'
import { fakeEnv } from '../testing/fake-env'
import {
  LAST_SNAPSHOT_KEY,
  prepareSessionSandbox,
  SANDBOX_HOME_KEY,
  saveSessionWork,
} from './handoff'
import { SPONSOR_STORAGE_KEY } from './sponsor'

const ORG = 'orgA0000000000000000000000000000'
const ALICE = userSandboxName(ORG, 'alice')
const BOB = userSandboxName(ORG, 'bob')

const repo = {
  installationId: 1,
  owner: 'acme',
  name: 'glue',
  fullName: 'acme/glue',
  defaultBranch: 'main',
  private: true,
}

const PULL = { fullName: 'acme/glue', number: 8, headSha: 'head123', baseSha: 'base456' }

const snapshotOf = (sandbox: string): SessionSnapshot => ({
  repoName: 'glue',
  head: 'shuttle/x/glue',
  headSha: 'aaa',
  snapshotSha: `snapshot-from-${sandbox}`,
  branches: [],
  config: [],
})

/** Sandboxes that record what they are asked to do. `empty` ones have no worktree to snapshot. */
function world(
  mode: string | undefined,
  empty: readonly string[] = [],
  repos: readonly (typeof repo)[] = [repo],
) {
  const calls: string[] = []

  const values = new Map<string, unknown>([
    [ACCESS_STORAGE_KEY, { ownerId: 'alice', memberIds: ['bob'], visibility: 'private' }],
  ])

  const storage = {
    get: async (key: string) => values.get(key),
    put: async (key: string, value: unknown) => {
      values.set(key, value)
    },
  } as unknown as DurableObjectStorage

  const env = fakeEnv({
    ...(mode ? { SHUTTLE_WORKSPACE_MODE: mode } : {}),
    SANDBOX: {
      getByName: (name: string) => ({
        ensureRepos: async () => {
          calls.push(`${name} ensureRepos`)
          return { root: '/workspace' }
        },
        ensureWorktree: async () => {
          calls.push(`${name} ensureWorktree`)
          return { root: '/workspace', repoDirs: [] }
        },
        checkoutRef: async (_runId: string, target: { name: string }, ref: { sha: string }) => {
          calls.push(`${name} checkout ${target.name}@${ref.sha}`)
          return { root: '/workspace' }
        },
        snapshotSession: async (_runId: string, target: { name: string }) => {
          calls.push(
            target.name === 'glue' ? `${name} snapshot` : `${name} snapshot ${target.name}`,
          )

          return { snapshot: empty.includes(name) ? null : snapshotOf(name) }
        },
        restoreSession: async (_runId: string, _repo: unknown, snapshot: SessionSnapshot) => {
          calls.push(`${name} restore ${snapshot.snapshotSha}`)
          return { ok: true }
        },
      }),
    } as unknown as ShuttleEnv['SANDBOX'],
  })

  const work = async (runId: string, sponsor?: string, pull?: typeof PULL) => {
    if (sponsor) {
      values.set(SPONSOR_STORAGE_KEY, sponsor)
    }

    calls.length = 0

    await prepareSessionSandbox(env, storage, runId, {
      sandboxName: 'folder:f1',
      repos,
      ...(pull ? { pull } : {}),
    })

    return [...calls]
  }

  return { work, home: () => values.get(SANDBOX_HOME_KEY) }
}

describe('prepareSessionSandbox', () => {
  test("a review session's worktree is the pull request's head, in the sandbox its tools use", async () => {
    const { work, home } = world('daytona')
    const run = scopedRunId(ORG, 'session_reviews')

    // Alice's sandbox, not the folder's the session was bound to.
    expect(await work(run, undefined, PULL)).toEqual([
      `${ALICE} ensureRepos`,
      `${ALICE} checkout glue@head123`,
      `${ALICE} ensureWorktree`,
    ])

    expect(home()).toBe(ALICE)
    expect(await work(run, undefined, PULL)).toEqual([])

    // A move carries the worktree along, so the head is not checked out over it again.
    expect(await work(run, 'bob', PULL)).toEqual([
      `${ALICE} snapshot`,
      `${BOB} restore snapshot-from-${ALICE}`,
      `${BOB} ensureWorktree`,
    ])
  })

  test('a review session with no head commit or no linked repository fails loudly', async () => {
    const { work } = world('daytona')

    await expect(
      work(scopedRunId(ORG, 'session_no_head'), undefined, { ...PULL, headSha: '' }),
    ).rejects.toThrow('without the pull request')

    await expect(
      work(scopedRunId(ORG, 'session_no_repo'), undefined, { ...PULL, fullName: 'acme/other' }),
    ).rejects.toThrow('not linked')
  })

  test("a session starts in its owner's sandbox and stays put while they work", async () => {
    const { work, home } = world('daytona')
    const run = scopedRunId(ORG, 'session_stays')

    expect(await work(run)).toEqual([`${ALICE} ensureRepos`, `${ALICE} ensureWorktree`])
    expect(home()).toBe(ALICE)

    // The next tool call finds everything in place.
    expect(await work(run)).toEqual([])
  })

  test('when someone else asks for work, the session moves to their sandbox first', async () => {
    const { work, home } = world('daytona')
    const run = scopedRunId(ORG, 'session_moves')

    await work(run)

    expect(await work(run, 'bob')).toEqual([
      `${ALICE} snapshot`,
      `${BOB} restore snapshot-from-${ALICE}`,
      `${BOB} ensureWorktree`,
    ])

    expect(home()).toBe(BOB)
    expect(await work(run)).toEqual([])

    // And back again, carrying what Bob did.
    expect(await work(run, 'alice')).toEqual([
      `${BOB} snapshot`,
      `${ALICE} restore snapshot-from-${BOB}`,
      `${ALICE} ensureWorktree`,
    ])

    expect(home()).toBe(ALICE)
  })

  test('a sandbox with no work to move leaves the new one to start fresh', async () => {
    const { work, home } = world('daytona', [ALICE])
    const run = scopedRunId(ORG, 'session_empty')

    await work(run)

    expect(await work(run, 'bob')).toEqual([
      `${ALICE} snapshot`,
      `${BOB} ensureRepos`,
      `${BOB} ensureWorktree`,
    ])

    expect(home()).toBe(BOB)
  })

  test('a session with no linked repository moves too, carrying its demo repository', async () => {
    const { work, home } = world('daytona', [], [])
    const run = scopedRunId(ORG, 'session_demo')

    await work(run)

    expect(await work(run, 'bob')).toEqual([
      `${ALICE} snapshot demo`,
      `${BOB} restore snapshot-from-${ALICE}`,
      `${BOB} ensureWorktree`,
    ])

    expect(home()).toBe(BOB)
  })

  test('concurrent tool calls share one preparation', async () => {
    const { work } = world('daytona')
    const run = scopedRunId(ORG, 'session_concurrent')

    const [first, second] = await Promise.all([work(run), work(run)])

    // Both saw the same calls: the setup ran once.
    expect(first).toEqual(second)
    expect(first.filter((call) => call.endsWith('ensureRepos'))).toHaveLength(1)
  })

  test('where sandboxes are per folder, a session never moves', async () => {
    const { work, home } = world('container')
    const run = scopedRunId(ORG, 'session_folder')

    expect(await work(run)).toEqual(['folder:f1 ensureRepos', 'folder:f1 ensureWorktree'])
    expect(await work(run, 'bob')).toEqual([])
    expect(home()).toBe('folder:f1')
  })
})

describe('saveSessionWork', () => {
  function saver(mode: string | undefined, home: string | undefined, empty = false) {
    const asked: string[] = []
    const values = new Map<string, unknown>(home ? [[SANDBOX_HOME_KEY, home]] : [])

    const storage = {
      get: async (key: string) => values.get(key),
      put: async (key: string, value: unknown) => {
        values.set(key, value)
      },
    } as unknown as DurableObjectStorage

    const env = fakeEnv({
      ...(mode ? { SHUTTLE_WORKSPACE_MODE: mode } : {}),
      SANDBOX: {
        getByName: (name: string) => ({
          snapshotSession: async (_runId: string, target: { name: string }) => {
            asked.push(`${name} ${target.name}`)
            return { snapshot: empty ? null : snapshotOf(name) }
          },
        }),
      } as unknown as ShuttleEnv['SANDBOX'],
    })

    return { env, storage, asked, record: () => values.get(LAST_SNAPSHOT_KEY) }
  }

  const run = scopedRunId(ORG, 'session_save')

  test('saves from the sandbox the session is in and records what was saved', async () => {
    const { env, storage, asked, record } = saver('daytona', BOB)

    const saved = await saveSessionWork(env, storage, run, [repo], 1234)

    expect(asked).toEqual([`${BOB} glue`])

    expect(saved).toEqual({
      at: 1234,
      sandboxName: BOB,
      repos: [{ name: 'glue', head: 'shuttle/x/glue', snapshotSha: `snapshot-from-${BOB}` }],
    })

    expect(record()).toEqual(saved)
  })

  test('a session with no linked repository saves its demo repository', async () => {
    const { env, storage, asked } = saver('daytona', ALICE)

    await saveSessionWork(env, storage, run, [])

    expect(asked).toEqual([`${ALICE} demo`])
  })

  test('does nothing before the session has worked anywhere, or where sandboxes are per folder', async () => {
    const fresh = saver('daytona', undefined)
    const folder = saver('container', 'folder:f1')
    const nothingYet = saver('daytona', ALICE, true)

    expect(await saveSessionWork(fresh.env, fresh.storage, run, [repo])).toBeNull()
    expect(await saveSessionWork(folder.env, folder.storage, run, [repo])).toBeNull()
    expect(await saveSessionWork(nothingYet.env, nothingYet.storage, run, [repo])).toBeNull()
    expect(fresh.asked).toEqual([])
    expect(folder.asked).toEqual([])
    expect(nothingYet.record()).toBeUndefined()
  })
})

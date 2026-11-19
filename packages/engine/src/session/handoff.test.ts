import { describe, expect, test } from 'bun:test'

import { localSandboxName, userSandboxName } from '@shuttle/sandbox/names'
import type { SessionSnapshot } from '@shuttle/sandbox/session-sync'
import type { JsonValue } from '@swirls/looms/core'

import type { EngineEnv } from '../env'
import { ACCESS_STORAGE_KEY } from '../tenancy/access'
import { scopedRunId } from '../tenancy/run-id'
import { fakeEnv } from '../testing/fake-env'
import { SANDBOX_PLACEMENT_KEY } from './bind-sandbox'
import {
  applyPendingPlacement,
  LAST_MOVE_KEY,
  LAST_SNAPSHOT_KEY,
  PENDING_PLACEMENT_KEY,
  prepareSessionSandbox,
  SANDBOX_HOME_KEY,
  saveSessionWork,
  type PendingPlacement,
  type SavedSnapshot,
  type SessionMove,
} from './handoff'
import { SPONSOR_STORAGE_KEY } from './sponsor'

const ORG = 'orgA0000000000000000000000000000'
const ALICE = userSandboxName(ORG, 'alice')
const BOB = userSandboxName(ORG, 'bob')
const LAPTOP = localSandboxName(ORG, 'alice', 'laptop-1')

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

/** What the session's storage holds in these tests: strings, and records the code writes. */
type StoredValue = JsonValue | PendingPlacement | SavedSnapshot | SessionMove

/** A Durable Object storage that keeps what is put in it in `values`. */
function memoryStorage(values: Map<string, StoredValue>): DurableObjectStorage {
  const fake = {
    get: async (key: string) => values.get(key),
    put: async (key: string, value: StoredValue) => {
      values.set(key, value)
    },
    delete: async (key: string) => values.delete(key),
  }

  // SAFETY: the code under test only calls `get`, `put` and `delete` with a single key, which
  // `fake` answers as Durable Object storage does; no other method or overload is reached.
  return fake as DurableObjectStorage
}

/** The message a promise rejects with, or an empty string when it resolves. */
async function failureOf<T>(attempt: Promise<T>): Promise<string> {
  try {
    await attempt
  } catch (error) {
    return error instanceof Error ? error.message : ''
  }

  return ''
}

/** Sandboxes that record what they are asked to do. `empty` ones have no worktree to snapshot. */
function world(
  mode: string | undefined,
  empty: readonly string[] = [],
  repos: readonly (typeof repo)[] = [repo],
  /** Sandboxes on a machine that is not connected. */
  offline: readonly string[] = [],
) {
  const calls: string[] = []

  const values = new Map<string, StoredValue>([
    [ACCESS_STORAGE_KEY, { ownerId: 'alice', memberIds: ['bob'], visibility: 'private' }],
  ])

  const storage = memoryStorage(values)

  const sandboxes = {
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
        if (offline.includes(name)) {
          throw new Error('sandbox-offline: the machine is not connected')
        }

        calls.push(target.name === 'glue' ? `${name} snapshot` : `${name} snapshot ${target.name}`)

        return { snapshot: empty.includes(name) ? null : snapshotOf(name) }
      },
      restoreSession: async (_runId: string, _repo: typeof repo, snapshot: SessionSnapshot) => {
        calls.push(`${name} restore ${snapshot.snapshotSha}`)
        return { ok: true }
      },
    }),
  }

  // SAFETY: the code under test only calls `getByName(name)` and the sandbox methods defined
  // above, so the fake namespace needs nothing else of the real one.
  const namespace: EngineEnv['SANDBOX'] = sandboxes as never

  const env = fakeEnv(
    mode === undefined || mode === ''
      ? { SANDBOX: namespace }
      : { SHUTTLE_WORKSPACE_MODE: mode, SANDBOX: namespace },
  )

  const work = async (runId: string, sponsor?: string, pull?: typeof PULL) => {
    if (sponsor !== undefined && sponsor !== '') {
      values.set(SPONSOR_STORAGE_KEY, sponsor)
    }

    calls.length = 0

    await prepareSessionSandbox(
      env,
      storage,
      runId,
      pull === undefined
        ? { sandboxName: 'folder:f1', repos }
        : { sandboxName: 'folder:f1', repos, pull },
    )

    return [...calls]
  }

  return { work, values, env, storage, calls, home: () => values.get(SANDBOX_HOME_KEY) }
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

    expect(
      await failureOf(
        work(scopedRunId(ORG, 'session_no_head'), undefined, { ...PULL, headSha: '' }),
      ),
    ).toContain('without the pull request')

    expect(
      await failureOf(
        work(scopedRunId(ORG, 'session_no_repo'), undefined, { ...PULL, fullName: 'acme/other' }),
      ),
    ).toContain('not linked')
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

describe("a session placed on a person's own machine", () => {
  // Preparations are remembered per run, so each test has a run of its own.
  let count = 0
  const newRun = () => scopedRunId(ORG, `session_local_${++count}`)
  const place = { kind: 'local', userId: 'alice', deviceId: 'laptop-1' }

  test('works on the machine, and carries its work to the cloud and back', async () => {
    const run = newRun()
    const { work, values, home } = world('daytona')

    values.set(SANDBOX_PLACEMENT_KEY, place)
    expect(await work(run, 'alice')).toEqual([`${LAPTOP} ensureRepos`, `${LAPTOP} ensureWorktree`])
    expect(home()).toBe(LAPTOP)

    values.delete(SANDBOX_PLACEMENT_KEY)

    expect(await work(run)).toEqual([
      `${LAPTOP} snapshot`,
      `${ALICE} restore snapshot-from-${LAPTOP}`,
      `${ALICE} ensureWorktree`,
    ])

    values.set(SANDBOX_PLACEMENT_KEY, place)

    expect(await work(run)).toEqual([
      `${ALICE} snapshot`,
      `${LAPTOP} restore snapshot-from-${ALICE}`,
      `${LAPTOP} ensureWorktree`,
    ])
  })

  test('moves between a machine and a folder sandbox where sandboxes are shared', async () => {
    const run = newRun()
    const { work, values } = world('container')

    values.set(SANDBOX_PLACEMENT_KEY, place)
    await work(run, 'alice')
    values.delete(SANDBOX_PLACEMENT_KEY)

    expect(await work(run)).toEqual([
      `${LAPTOP} snapshot`,
      `folder:f1 restore snapshot-from-${LAPTOP}`,
      `folder:f1 ensureWorktree`,
    ])
  })

  test('a turn for someone else runs in their cloud sandbox, not on the machine', async () => {
    const run = newRun()
    const { work, values, home } = world('daytona')

    values.set(SANDBOX_PLACEMENT_KEY, place)
    await work(run, 'alice')

    expect(await work(run, 'bob')).toEqual([
      `${LAPTOP} snapshot`,
      `${BOB} restore snapshot-from-${LAPTOP}`,
      `${BOB} ensureWorktree`,
    ])

    expect(home()).toBe(BOB)
  })

  test('leaves a machine that is not connected from its last save', async () => {
    const run = newRun()
    const { work, values } = world('daytona', [], [repo], [LAPTOP])

    values.set(SANDBOX_HOME_KEY, LAPTOP)

    values.set(LAST_SNAPSHOT_KEY, {
      at: 1,
      sandboxName: LAPTOP,
      repos: [],
      carried: [{ repo, snapshot: snapshotOf('the-last-save') }],
    })

    expect(await work(run, 'alice')).toEqual([
      `${ALICE} restore snapshot-from-the-last-save`,
      `${ALICE} ensureWorktree`,
    ])

    // Recorded, so the session can say that what changed on the machine since is still there.
    expect(values.get(LAST_MOVE_KEY)).toMatchObject({ from: LAPTOP, to: ALICE, fromSave: true })
  })

  test('a move asked for during a turn happens when it is applied, and only once', async () => {
    const run = newRun()
    const { work, values, env, storage, calls, home } = world('daytona')
    const binding = { sandboxName: 'folder:f1', repos: [repo] }

    await work(run, 'alice')
    expect(home()).toBe(ALICE)

    values.set(PENDING_PLACEMENT_KEY, { placement: place })
    calls.length = 0

    expect(await applyPendingPlacement(env, storage, run, binding)).toBe(true)

    expect(calls).toEqual([
      `${ALICE} snapshot`,
      `${LAPTOP} restore snapshot-from-${ALICE}`,
      `${LAPTOP} ensureWorktree`,
    ])

    expect(home()).toBe(LAPTOP)
    expect(values.get(LAST_MOVE_KEY)).toMatchObject({ from: ALICE, to: LAPTOP, fromSave: false })

    expect(await applyPendingPlacement(env, storage, run, binding)).toBe(false)
  })

  test('does not leave a machine that is not connected with nothing saved', async () => {
    const run = newRun()
    const { work, values, home } = world('daytona', [], [repo], [LAPTOP])

    values.set(SANDBOX_HOME_KEY, LAPTOP)

    expect(await failureOf(work(run, 'alice'))).toContain('sandbox-offline')
    expect(home()).toBe(LAPTOP)
  })
})

function saver(mode: string | undefined, home: string | undefined, empty = false) {
  const asked: string[] = []

  const values = new Map<string, StoredValue>(
    home !== undefined && home !== '' ? [[SANDBOX_HOME_KEY, home]] : [],
  )

  const storage = memoryStorage(values)

  const sandboxes = {
    getByName: (name: string) => ({
      snapshotSession: async (_runId: string, target: { name: string }) => {
        asked.push(`${name} ${target.name}`)
        return { snapshot: empty ? null : snapshotOf(name) }
      },
    }),
  }

  // SAFETY: `saveSessionWork` only calls `getByName(name).snapshotSession(...)`, which the fake
  // above answers; no other method of the real namespace is reached.
  const namespace: EngineEnv['SANDBOX'] = sandboxes as never

  const env = fakeEnv(
    mode === undefined || mode === ''
      ? { SANDBOX: namespace }
      : { SHUTTLE_WORKSPACE_MODE: mode, SANDBOX: namespace },
  )

  return { env, storage, asked, record: () => values.get(LAST_SNAPSHOT_KEY) }
}

describe('saveSessionWork', () => {
  const run = scopedRunId(ORG, 'session_save')

  test('saves from the sandbox the session is in and records what was saved', async () => {
    const { env, storage, asked, record } = saver('daytona', BOB)

    const saved = await saveSessionWork(env, storage, run, [repo], 1234)

    expect(asked).toEqual([`${BOB} glue`])

    expect(saved).toEqual({
      at: 1234,
      sandboxName: BOB,
      repos: [{ name: 'glue', head: 'shuttle/x/glue', snapshotSha: `snapshot-from-${BOB}` }],
      carried: [{ repo, snapshot: snapshotOf(BOB) }],
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

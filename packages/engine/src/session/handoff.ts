import { DEMO_REPO, sandboxCarriesWork, sandboxIsPersonal } from '@shuttle/sandbox/names'
import { isSandboxOffline } from '@shuttle/sandbox/providers/local'
import type { SessionSnapshot } from '@shuttle/sandbox/session-sync'
import type { LinkedSandboxRepo } from '@shuttle/sandbox/workspace'

import { sandboxStub, type SessionSandboxStub, type EngineEnv } from '../env'
import {
  readSandboxPlacement,
  sandboxNameForSession,
  writeSandboxPlacement,
  type SandboxBinding,
  type SandboxPlacement,
} from './bind-sandbox'

/**
 * Gets a session's sandbox ready for work, moving the session there first if it was last worked
 * on somewhere else.
 *
 * A session's sandbox changes when the person it is working for changes (where each person has
 * a sandbox of their own) and when someone moves it between their own machine and the cloud.
 * Either way the session's work so far (its branches and its uncommitted files) is pushed to Code
 * Storage from the sandbox it was in and rebuilt in the new one, so the next turn continues from
 * exactly where the last one stopped. Which providers the two sandboxes run on makes no
 * difference. Agent turns in a session run one at a time, so this happens between turns, never
 * under a running one.
 *
 * A session's work is also saved every time it stops working (`saveSessionWork`). That is what
 * lets a session leave a machine that is no longer reachable, such as a laptop that was closed:
 * the new sandbox is rebuilt from the last save.
 */

/** The sandbox that holds the session's worktree. */
export const SANDBOX_HOME_KEY = 'shuttle:sandbox-home'

type HandoffStorage = Pick<DurableObjectStorage, 'get' | 'put'>

type HandoffSandbox = Pick<
  SessionSandboxStub,
  'ensureRepos' | 'ensureWorktree' | 'checkoutRef' | 'snapshotSession' | 'restoreSession'
>

/** Preparations under way, by session, so concurrent tool calls share one. */
const inFlight = new Map<string, Promise<string>>()

/** Sandboxes already prepared for a session in this isolate, to skip repeating the setup. */
const prepared = new Map<string, string>()

type CarriedWork = readonly {
  readonly repo: LinkedSandboxRepo
  readonly snapshot: SessionSnapshot
}[]

/**
 * Moves the session from `from` to `to`. Returns what was carried, which is nothing when `from`
 * had nothing to move, and whether it came from the last save and not from `from` itself.
 *
 * `saved` is the session's work as it was last saved from `from`. It is used only when `from`
 * cannot be reached, so whatever changed there since that save stays behind on that machine.
 */
export async function moveSession(
  from: HandoffSandbox,
  to: HandoffSandbox,
  runId: string,
  repos: readonly LinkedSandboxRepo[],
  saved: CarriedWork = [],
): Promise<{ carried: CarriedWork; fromSave: boolean }> {
  let snapshots: { repo: LinkedSandboxRepo; snapshot: SessionSnapshot }[] = []
  let fromSave = false

  // Everything is pushed before anything is rebuilt, so a failure leaves the old sandbox whole.
  try {
    for (const repo of repos) {
      const { snapshot } = await from.snapshotSession(runId, repo)

      if (snapshot) {
        snapshots.push({ repo, snapshot })
      }
    }
  } catch (cause) {
    if (!isSandboxOffline(cause) || saved.length === 0) {
      throw cause
    }

    snapshots = [...saved]
    fromSave = true
  }

  for (const { repo, snapshot } of snapshots) {
    await to.restoreSession(runId, repo, snapshot)
  }

  return { carried: snapshots, fromSave }
}

/** The last time the session's work was carried from one sandbox to another. */
export const LAST_MOVE_KEY = 'shuttle:last-move'

export interface SessionMove {
  readonly at: number
  readonly from: string
  readonly to: string
  /**
   * True when `from` could not be reached and the work came from its last save. Whatever
   * changed there after that save is still there, and is not in the session.
   */
  readonly fromSave: boolean
}

/** Checks the head of `pull` out as the session's worktree for its repository. */
async function checkoutPull(
  sandbox: HandoffSandbox,
  runId: string,
  repos: readonly LinkedSandboxRepo[],
  pull: NonNullable<SandboxBinding['pull']>,
): Promise<void> {
  const repo = repos.find((item) => item.fullName === pull.fullName)

  if (!repo) {
    throw new Error(
      `Cannot review ${pull.fullName}#${pull.number}: ${pull.fullName} is not linked to this session.`,
    )
  }

  if (pull.headSha === '') {
    throw new Error(
      `Cannot review ${pull.fullName}#${pull.number}: the session was started without the pull request's head commit.`,
    )
  }

  await sandbox.checkoutRef(
    runId,
    repo,
    pull.baseSha === '' ? { sha: pull.headSha } : { sha: pull.headSha, baseSha: pull.baseSha },
  )
}

async function prepare(
  env: EngineEnv,
  storage: HandoffStorage | undefined,
  runId: string,
  name: string,
  binding: SandboxBinding,
): Promise<string> {
  const { repos, pull } = binding
  const sandbox = sandboxStub(env, name)
  const home = storage ? await storage.get<string>(SANDBOX_HOME_KEY) : undefined

  if (prepared.get(runId) === name && (home === undefined || home === name)) {
    return name
  }

  // A session with no linked repository still has work to carry: the demo repository's.
  const { carried, fromSave } =
    storage !== undefined &&
    home !== undefined &&
    home !== '' &&
    home !== name &&
    sandboxCarriesWork(home, env) &&
    sandboxCarriesWork(name, env)
      ? await moveSession(
          sandboxStub(env, home),
          sandbox,
          runId,
          repos.length > 0 ? repos : [DEMO_REPO],
          await savedWorkFrom(storage, home),
        )
      : { carried: [], fromSave: false }

  const moved = carried.length > 0

  // What was carried is the newest copy of the session's work, and it is now here. Recording
  // it as this sandbox's last save lets the session leave again even if this one goes away.
  if (storage && moved) {
    await storage.put(LAST_SNAPSHOT_KEY, {
      at: Date.now(),
      sandboxName: name,
      repos: carried.map(({ repo, snapshot }) => ({
        name: repo.name,
        head: snapshot.head,
        snapshotSha: snapshot.snapshotSha,
      })),
      carried,
    } satisfies SavedSnapshot)

    await storage.put(LAST_MOVE_KEY, {
      at: Date.now(),
      from: home ?? '',
      to: name,
      fromSave,
    } satisfies SessionMove)
  }

  if (!moved) {
    await sandbox.ensureRepos([...repos])

    // A review session reads a pull request, so its worktree is that pull request's head and
    // not the default branch. Done once per sandbox, here, so it lands in the sandbox the
    // session's tools use; after a move the worktree arrives with the rest of the session.
    if (pull && home !== name) {
      await checkoutPull(sandbox, runId, repos, pull)
    }
  }

  // After a move this only fills in repositories the session had not touched yet.
  await sandbox.ensureWorktree(runId)

  if (storage && home !== name) {
    await storage.put(SANDBOX_HOME_KEY, name)
  }

  prepared.set(runId, name)

  return name
}

/** The session's sandbox, with its repositories and worktree in place. */
export async function prepareSessionSandbox(
  env: EngineEnv,
  storage: DurableObjectStorage | undefined,
  runId: string,
  binding: SandboxBinding,
): Promise<SessionSandboxStub> {
  const name = await sandboxNameForSession(env, storage, runId, binding.sandboxName)
  const key = `${runId}\n${name}`
  let pending = inFlight.get(key)

  if (!pending) {
    pending = prepare(env, storage, runId, name, binding).finally(() => inFlight.delete(key))
    inFlight.set(key, pending)
  }

  return sandboxStub(env, await pending)
}

/** A move someone asked for while the session was working. It happens when the turn ends. */
export const PENDING_PLACEMENT_KEY = 'shuttle:sandbox-placement-pending'

export interface PendingPlacement {
  /** Where to: one of a person's machines, or null for the cloud. */
  readonly placement: SandboxPlacement | null
}

/**
 * Carries out a move that was waiting for the session to stop working. Returns whether there
 * was one. A move that fails is dropped, and the session stays where it is.
 */
export async function applyPendingPlacement(
  env: EngineEnv,
  storage: DurableObjectStorage,
  runId: string,
  binding: SandboxBinding | null,
): Promise<boolean> {
  const pending = await storage.get<PendingPlacement>(PENDING_PLACEMENT_KEY)

  if (!pending) {
    return false
  }

  await storage.delete(PENDING_PLACEMENT_KEY)

  const before = await readSandboxPlacement(storage)

  await writeSandboxPlacement(storage, pending.placement)

  if (binding) {
    try {
      await prepareSessionSandbox(env, storage, runId, binding)
    } catch (cause) {
      await writeSandboxPlacement(storage, before)

      throw cause
    }
  }

  return true
}

/** The last time the session's work was saved to Code Storage, and what was saved. */
export const LAST_SNAPSHOT_KEY = 'shuttle:last-snapshot'

export interface SavedSnapshot {
  readonly at: number
  /** The sandbox the work was saved from. */
  readonly sandboxName: string
  readonly repos: readonly {
    readonly name: string
    readonly head: string
    readonly snapshotSha: string
  }[]
  /** Everything needed to rebuild the work somewhere else without asking that sandbox again. */
  readonly carried?: CarriedWork
}

/** The session's work as last saved from `sandboxName`, in the form another sandbox rebuilds from. */
async function savedWorkFrom(storage: HandoffStorage, sandboxName: string): Promise<CarriedWork> {
  const saved = await storage.get<SavedSnapshot>(LAST_SNAPSHOT_KEY)

  return saved?.sandboxName === sandboxName ? (saved.carried ?? []) : []
}

/**
 * Saves the session's work to Code Storage from the sandbox it is in, without moving it. Called
 * when a session stops working, so what an agent did survives the sandbox being lost and is
 * there to pick up from anywhere.
 *
 * Returns null where there is nothing to do: the session's sandbox is shared, or the session has
 * not worked anywhere yet.
 */
export async function saveSessionWork(
  env: EngineEnv,
  storage: HandoffStorage,
  runId: string,
  repos: readonly LinkedSandboxRepo[],
  now = Date.now(),
): Promise<SavedSnapshot | null> {
  const home = await storage.get<string>(SANDBOX_HOME_KEY)

  if (home === undefined || home === '' || !sandboxIsPersonal(home, env)) {
    return null
  }

  const sandbox = sandboxStub(env, home)
  const saved = []
  const carried = []

  for (const repo of repos.length > 0 ? repos : [DEMO_REPO]) {
    const { snapshot } = await sandbox.snapshotSession(runId, repo)

    if (snapshot) {
      saved.push({ name: repo.name, head: snapshot.head, snapshotSha: snapshot.snapshotSha })
      carried.push({ repo, snapshot })
    }
  }

  if (saved.length === 0) {
    return null
  }

  const record: SavedSnapshot = { at: now, sandboxName: home, repos: saved, carried }

  await storage.put(LAST_SNAPSHOT_KEY, record)

  return record
}

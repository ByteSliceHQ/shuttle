import { sandboxStub, type SessionSandboxStub, type ShuttleEnv } from '../env'
import { DEMO_REPO, sandboxesArePersonal } from '../sandbox/names'
import type { LinkedSandboxRepo } from '../sandbox/workspace'
import { sandboxNameForSession, type SandboxBinding } from './bind-sandbox'

/**
 * Gets a session's sandbox ready for work, moving the session there first if it was last worked
 * on somewhere else.
 *
 * Where each person has a sandbox of their own, a session runs in the sandbox of whoever it is
 * working for. When that person changes, the session's work so far (its branches and its
 * uncommitted files) is pushed from the sandbox it was in and rebuilt in the new one, so the next
 * turn continues from exactly where the last one stopped. Agent turns in a session run one at a
 * time, so this happens between turns, never under a running one.
 */

/** The sandbox that holds the session's worktree. */
export const SANDBOX_HOME_KEY = 'shuttle:sandbox-home'

type HandoffStorage = Pick<DurableObjectStorage, 'get' | 'put'>

type HandoffSandbox = Pick<
  SessionSandboxStub,
  'ensureRepos' | 'ensureWorktree' | 'snapshotSession' | 'restoreSession'
>

/** Preparations under way, by session, so concurrent tool calls share one. */
const inFlight = new Map<string, Promise<string>>()

/** Sandboxes already prepared for a session in this isolate, to skip repeating the setup. */
const prepared = new Map<string, string>()

/** Moves the session from `from` to `to`. Returns false when `from` had nothing to move. */
export async function moveSession(
  from: HandoffSandbox,
  to: HandoffSandbox,
  runId: string,
  repos: readonly LinkedSandboxRepo[],
): Promise<boolean> {
  const snapshots = []

  // Everything is pushed before anything is rebuilt, so a failure leaves the old sandbox whole.
  for (const repo of repos) {
    const { snapshot } = await from.snapshotSession(runId, repo)

    if (snapshot) {
      snapshots.push({ repo, snapshot })
    }
  }

  if (snapshots.length === 0) {
    return false
  }

  for (const { repo, snapshot } of snapshots) {
    await to.restoreSession(runId, repo, snapshot)
  }

  return true
}

async function prepare(
  env: ShuttleEnv,
  storage: HandoffStorage | undefined,
  runId: string,
  name: string,
  repos: readonly LinkedSandboxRepo[],
): Promise<string> {
  const sandbox = sandboxStub(env, name)
  const home = storage ? await storage.get<string>(SANDBOX_HOME_KEY) : undefined

  if (prepared.get(runId) === name && (home === undefined || home === name)) {
    return name
  }

  // A session with no linked repository still has work to carry: the demo repository's.
  const moved =
    storage && sandboxesArePersonal(env) && home && home !== name
      ? await moveSession(
          sandboxStub(env, home),
          sandbox,
          runId,
          repos.length > 0 ? repos : [DEMO_REPO],
        )
      : false

  if (!moved) {
    await sandbox.ensureRepos([...repos])
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
  env: ShuttleEnv,
  storage: DurableObjectStorage | undefined,
  runId: string,
  binding: SandboxBinding,
): Promise<SessionSandboxStub> {
  const name = await sandboxNameForSession(env, storage, runId, binding.sandboxName)
  const key = `${runId}\n${name}`
  let pending = inFlight.get(key)

  if (!pending) {
    pending = prepare(env, storage, runId, name, binding.repos).finally(() => inFlight.delete(key))
    inFlight.set(key, pending)
  }

  return sandboxStub(env, await pending)
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
}

/**
 * Saves the session's work to Code Storage from the sandbox it is in, without moving it. Called
 * when a session stops working, so what an agent did survives the sandbox being lost and is
 * there to pick up from anywhere.
 *
 * Returns null where there is nothing to do: sandboxes are not personal, or the session has not
 * worked anywhere yet.
 */
export async function saveSessionWork(
  env: ShuttleEnv,
  storage: HandoffStorage,
  runId: string,
  repos: readonly LinkedSandboxRepo[],
  now = Date.now(),
): Promise<SavedSnapshot | null> {
  const home = sandboxesArePersonal(env) ? await storage.get<string>(SANDBOX_HOME_KEY) : undefined

  if (!home) {
    return null
  }

  const sandbox = sandboxStub(env, home)
  const saved = []

  for (const repo of repos.length > 0 ? repos : [DEMO_REPO]) {
    const { snapshot } = await sandbox.snapshotSession(runId, repo)

    if (snapshot) {
      saved.push({ name: repo.name, head: snapshot.head, snapshotSha: snapshot.snapshotSha })
    }
  }

  if (saved.length === 0) {
    return null
  }

  const record: SavedSnapshot = { at: now, sandboxName: home, repos: saved }

  await storage.put(LAST_SNAPSHOT_KEY, record)

  return record
}

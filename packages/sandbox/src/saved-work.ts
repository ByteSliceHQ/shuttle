import { NotFoundError } from '@pierre/sdk'

import { codeStorageRepoName, scratchRepoName } from '@shuttle/git/codestorage/client'

import { DEMO_REPO, isDemoRepo } from './names'
import { sessionRemoteRefs } from './session-sync'
import type { LinkedSandboxRepo } from './workspace'
import { isNeverWork, type WorkspaceRepoSummary } from './workspace-summary'

/**
 * Reads a session's work as it was last saved to Code Storage, without a sandbox.
 *
 * A save is a commit holding the session's working files, on a branch only that session can
 * push (see `session-sync.ts`). This reads that commit back: its files, one file's text, and how
 * it differs from the commit the session's branch was on. It is what the Files and Changes tabs
 * show while the sandbox that holds the session is asleep, so looking at a session never wakes
 * someone's sandbox.
 */

/** The part of the Code Storage client this uses. The SDK's `Pierre` satisfies it. */
export interface SavedWorkClient {
  readonly repos: {
    readonly branches: {
      get(params: {
        repo_name: string
        name: string
        ephemeral: boolean
      }): PromiseLike<{ branch: { head_sha: string } }>
    }
    readonly commits: {
      get(params: { repo_name: string; sha: string }): PromiseLike<{ commit: { date: string } }>
    }
    readonly files: {
      list(params: {
        repo_name: string
        ref: string
        ephemeral: boolean
        recursive: boolean
      }): AsyncIterable<{ path: string; type: string }>
      get(params: {
        repo_name: string
        ref: string
        ephemeral: boolean
        path: string
      }): PromiseLike<Response>
    }
    readonly diff: {
      get(params: {
        repo_name: string
        ref: string
        ref_is_ephemeral: boolean
        base_ref?: string
        base_is_ephemeral?: boolean
        path?: string[]
      }): PromiseLike<{
        files: readonly { path: string; state: string; raw: string }[]
      }>
    }
  }
}

type SavedDiffParams = Parameters<SavedWorkClient['repos']['diff']['get']>[0]

/** One repository's saved work. */
export interface SavedRepo {
  /** The repository's directory in the session's worktree. */
  readonly name: string
  /** The Code Storage repository that holds the save. */
  readonly repoName: string
  readonly ref: string
  /** The branch holding the commit the session started from. Null for a save made without one. */
  readonly baseRef: string | null
  readonly sha: string
  /** When it was saved, in milliseconds. Null when Code Storage did not say. */
  readonly savedAt: number | null
}

async function missingAsNull<T>(read: () => PromiseLike<T>): Promise<T | null> {
  try {
    return await read()
  } catch (cause) {
    if (cause instanceof NotFoundError) {
      return null
    }

    throw cause
  }
}

/**
 * The saves that exist for a session, one per repository it works in. A linked repository's
 * save is on the organization's mirror when there is one, and otherwise in the session's own
 * repository, so both are looked in.
 */
export async function findSavedWork(
  client: SavedWorkClient,
  orgId: string,
  runId: string,
  repos: readonly LinkedSandboxRepo[],
): Promise<SavedRepo[]> {
  const saved: SavedRepo[] = []

  for (const repo of repos.length > 0 ? repos : [DEMO_REPO]) {
    const refs = sessionRemoteRefs(runId, repo.name)
    const ref = refs.work.replace(/^refs\/heads\//, '')
    const baseRef = refs.base.replace(/^refs\/heads\//, '')

    const places = [
      ...(isDemoRepo(repo) ? [] : [codeStorageRepoName(orgId, repo.fullName)]),
      scratchRepoName(orgId, runId),
    ]

    for (const repoName of places) {
      const found = await missingAsNull(() =>
        client.repos.branches.get({ repo_name: repoName, name: ref, ephemeral: true }),
      )

      if (!found) {
        continue
      }

      const sha = found.branch.head_sha

      // The save is a commit made at the moment of saving, so its date is when that was.
      const commit = await missingAsNull(() =>
        client.repos.commits.get({ repo_name: repoName, sha }),
      )

      const savedAt = commit ? Date.parse(commit.commit.date) : Number.NaN

      const hasBase = await missingAsNull(() =>
        client.repos.branches.get({ repo_name: repoName, name: baseRef, ephemeral: true }),
      )

      saved.push({
        name: repo.name,
        repoName,
        ref,
        baseRef: hasBase ? baseRef : null,
        sha,
        savedAt: Number.isFinite(savedAt) ? savedAt : null,
      })

      break
    }
  }

  return saved
}

/** Every saved file, as a path under the session's worktree: `<repository>/<path>`. */
export async function listSavedFiles(
  client: SavedWorkClient,
  saved: readonly SavedRepo[],
): Promise<string[]> {
  const paths: string[] = []

  for (const repo of saved) {
    const entries = client.repos.files.list({
      repo_name: repo.repoName,
      ref: repo.ref,
      ephemeral: true,
      recursive: true,
    })

    for await (const entry of entries) {
      if (entry.type === 'blob') {
        paths.push(`${repo.name}/${entry.path}`)
      }
    }
  }

  return paths
}

/** The text of one saved file, by its path under the worktree. Null when there is no such file. */
export async function readSavedFile(
  client: SavedWorkClient,
  saved: readonly SavedRepo[],
  path: string,
): Promise<string | null> {
  const slash = path.indexOf('/')
  const repo = saved.find((item) => item.name === path.slice(0, slash))

  if (slash < 0 || !repo) {
    return null
  }

  const response = await missingAsNull(() =>
    client.repos.files.get({
      repo_name: repo.repoName,
      ref: repo.ref,
      ephemeral: true,
      path: path.slice(slash + 1),
    }),
  )

  return response && response.ok ? response.text() : null
}

/**
 * One file as it was when the session started, by its path under the worktree. `content` is null
 * when the file did not exist then. The whole answer is null when the save does not carry the
 * session's starting point, so it cannot be known.
 */
export async function readSavedBaseFile(
  client: SavedWorkClient,
  saved: readonly SavedRepo[],
  path: string,
): Promise<{ content: string | null } | null> {
  const slash = path.indexOf('/')
  const repo = saved.find((item) => item.name === path.slice(0, slash))
  const baseRef = repo?.baseRef

  if (
    slash < 0 ||
    repo === undefined ||
    baseRef === undefined ||
    baseRef === null ||
    baseRef === ''
  ) {
    return null
  }

  const response = await missingAsNull(() =>
    client.repos.files.get({
      repo_name: repo.repoName,
      ref: baseRef,
      ephemeral: true,
      path: path.slice(slash + 1),
    }),
  )

  return { content: response && response.ok ? await response.text() : null }
}

/**
 * What a save changed. Measured from the commit the session started from when the save carries
 * it, and otherwise from the session's last commit, which shows only what was uncommitted.
 */
async function savedChanges(client: SavedWorkClient, repo: SavedRepo, paths?: string[]) {
  const params: SavedDiffParams = {
    repo_name: repo.repoName,
    ref: repo.ref,
    ref_is_ephemeral: true,
  }

  if (repo.baseRef !== null && repo.baseRef !== '') {
    params.base_ref = repo.baseRef
    params.base_is_ephemeral = true
  }

  if (paths !== undefined) {
    params.path = paths
  }

  const { files } = await client.repos.diff.get(params)

  return files
}

/** What each repository's save changed, as one diff per repository. */
export async function savedDiffs(
  client: SavedWorkClient,
  saved: readonly SavedRepo[],
): Promise<{ name: string; diff: string }[]> {
  const diffs = []

  for (const repo of saved) {
    const files = await savedChanges(client, repo)
    const diff = files.map((file) => file.raw.replace(/\n?$/, '\n')).join('')

    if (diff.trim() !== '') {
      diffs.push({ name: repo.name, diff })
    }
  }

  return diffs
}

/** One saved repository's files and which of them the session changed, for the workspace view. */
export async function savedRepoSummary(
  client: SavedWorkClient,
  repo: SavedRepo,
): Promise<WorkspaceRepoSummary> {
  const prefix = `${repo.name}/`

  const files = (await listSavedFiles(client, [repo]))
    .map((path) => path.slice(prefix.length))
    .filter((path) => !isNeverWork(path))

  const changes = (await savedChanges(client, repo))
    .filter((file) => !isNeverWork(file.path))
    .map((file): WorkspaceRepoSummary['changes'][number] => ({
      path: file.path,
      status: file.state.startsWith('A') ? 'A' : file.state.startsWith('D') ? 'D' : 'M',
    }))

  return { name: repo.name, files, changes }
}

/** One saved file's changes, by its path under the worktree. Empty when it has none. */
export async function savedFileDiff(
  client: SavedWorkClient,
  saved: readonly SavedRepo[],
  path: string,
): Promise<string> {
  const slash = path.indexOf('/')
  const repo = saved.find((item) => item.name === path.slice(0, slash))

  if (slash < 0 || !repo) {
    return ''
  }

  const files = await savedChanges(client, repo, [path.slice(slash + 1)])

  return files.map((file) => file.raw.replace(/\n?$/, '\n')).join('')
}

/** The latest time any of `saved` was saved, or null when none carries one. */
export function latestSave(saved: readonly SavedRepo[]): number | null {
  const times = saved.flatMap((repo) => (repo.savedAt === null ? [] : [repo.savedAt]))

  return times.length > 0 ? Math.max(...times) : null
}

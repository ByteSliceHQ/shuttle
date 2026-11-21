import { z } from 'zod'

import type { SandboxPathsRepo } from '@shuttle/api'

import { listSavedFiles, type SavedRepo, type SavedWorkClient } from './saved-work'
import { isNeverWork } from './workspace-summary'
import { MAX_PATHS_PER_REPO } from './worktree-paths'

/**
 * A session's paths while its sandbox sleeps, read from what it last saved to Code Storage.
 * Listing a large repository there takes many pages, so each save's list is kept in the edge
 * cache by its commit: a commit never changes, so neither does its list, and every later look at
 * the same save is one cache read.
 *
 * `etag` names a listing so the browser can ask whether it changed without downloading it again.
 */

/** How long a save's list is kept in the cache, in seconds. A commit's list never goes stale. */
const CACHE_SECONDS = 7 * 24 * 60 * 60

const CachedPaths = z.array(z.string())

/** What a cache needs to be: the Workers Cache API, or something that acts like it in tests. */
export interface PathsCache {
  match(request: Request): Promise<Response | undefined>
  put(request: Request, response: Response): Promise<void>
}

/** The Worker's edge cache, or null where there is none (unit tests, other runtimes). */
export function edgeCache(): PathsCache | null {
  const storage: unknown = 'caches' in globalThis ? globalThis.caches : undefined

  return hasDefaultCache(storage) ? storage.default : null
}

/** Whether `value` is the Workers runtime's `caches`, which has a `default` cache. */
function hasDefaultCache(value: unknown): value is { readonly default: PathsCache } {
  if (typeof value !== 'object' || value === null || !('default' in value)) {
    return false
  }

  const cache: unknown = value.default

  return (
    typeof cache === 'object' &&
    cache !== null &&
    'match' in cache &&
    typeof cache.match === 'function' &&
    'put' in cache &&
    typeof cache.put === 'function'
  )
}

/** Each saved repository's paths, from the cache where a list for its commit is there. */
export async function savedPaths(
  client: SavedWorkClient,
  saved: readonly SavedRepo[],
  cache: PathsCache | null,
): Promise<SandboxPathsRepo[]> {
  return Promise.all(
    saved.map(async (repo) => {
      const files = await cachedList(cache, repo, async () => {
        const prefix = `${repo.name}/`

        // The commit itself, not the save's ref: the ref may have moved on since, and the list
        // is kept under this commit.
        return (await listSavedFiles(client, [{ ...repo, ref: repo.sha }]))
          .map((path) => (path.startsWith(prefix) ? path.slice(prefix.length) : path))
          .filter((path) => !isNeverWork(path))
      })

      return {
        name: repo.name,
        files: files.slice(0, MAX_PATHS_PER_REPO),
        truncated: files.length > MAX_PATHS_PER_REPO,
      }
    }),
  )
}

async function cachedList(
  cache: PathsCache | null,
  repo: SavedRepo,
  list: () => Promise<string[]>,
): Promise<string[]> {
  const key = new Request(
    `https://shuttle.internal/cache/saved-paths/${encodeURIComponent(repo.repoName)}/${repo.sha}`,
  )

  const hit = cache === null ? undefined : await cache.match(key).catch(() => undefined)

  const cached =
    hit === undefined ? null : CachedPaths.safeParse(await hit.json().catch(() => null))

  if (cached?.success === true) {
    return cached.data
  }

  const files = await list()

  await cache
    ?.put(
      key,
      new Response(JSON.stringify(files), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `max-age=${CACHE_SECONDS}`,
        },
      }),
    )
    .catch(() => {})

  return files
}

/** The name of a saved listing: the commits it was read from. */
export function savedPathsEtag(saved: readonly SavedRepo[]): string {
  return `saved:${saved.map((repo) => `${repo.repoName}@${repo.sha}`).join(',')}`
}

/** The name of a listing read from a running sandbox: a digest of what the sandbox printed. */
export async function sandboxPathsEtag(listing: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(listing))
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')

  return `tree:${hex.slice(0, 32)}`
}

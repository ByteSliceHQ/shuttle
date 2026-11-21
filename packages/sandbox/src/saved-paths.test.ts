import { describe, expect, test } from 'bun:test'

import { sandboxPathsEtag, savedPaths, savedPathsEtag, type PathsCache } from './saved-paths'
import type { SavedRepo } from './saved-work'

/** A cache that keeps what it is given, as the Workers Cache API does for one key. */
function memoryCache(): PathsCache {
  const kept = new Map<string, string>()

  return {
    match: async (request) => {
      const body = kept.get(request.url)

      return body === undefined ? undefined : new Response(body)
    },
    put: async (request, response) => {
      kept.set(request.url, await response.text())
    },
  }
}

/** A Code Storage client that lists two files and node_modules, and counts how often it lists. */
function countingClient() {
  const refs: string[] = []
  const calls = { lists: 0, refs }

  const client = {
    repos: {
      files: {
        list: async function* (params: { ref: string }) {
          calls.lists += 1
          calls.refs.push(params.ref)
          yield { type: 'blob', path: 'README.md' }
          yield { type: 'blob', path: 'src/app.ts' }
          yield { type: 'blob', path: 'node_modules/x/index.js' }
          yield { type: 'tree', path: 'src' }
        },
      },
    },
  }

  // SAFETY: `listSavedFiles` only calls `repos.files.list` and reads `type` and `path`.
  return { client: client as never, calls }
}

const repo = (sha: string): SavedRepo => ({
  name: 'web',
  repoName: 'org-web',
  ref: 'refs/shuttle/save',
  baseRef: null,
  sha,
  savedAt: 1,
})

describe('savedPaths', () => {
  test('lists a save once and answers from the cache after that', async () => {
    const cache = memoryCache()
    const { client, calls } = countingClient()

    const first = await savedPaths(client, [repo('abc')], cache)
    const again = await savedPaths(client, [repo('abc')], cache)

    expect(first).toEqual([{ name: 'web', files: ['README.md', 'src/app.ts'], truncated: false }])
    expect(again).toEqual(first)
    expect(calls.lists).toBe(1)
    // The commit the list is kept under, not the save's ref, which may have moved on.
    expect(calls.refs).toEqual(['abc'])
  })

  test('lists again for a new save, and every time with no cache', async () => {
    const cache = memoryCache()
    const { client, calls } = countingClient()

    await savedPaths(client, [repo('abc')], cache)
    await savedPaths(client, [repo('def')], cache)
    await savedPaths(client, [repo('def')], null)

    expect(calls.lists).toBe(3)
  })
})

describe('etags', () => {
  test('name a save by its commits and a listing by what it printed', async () => {
    expect(savedPathsEtag([repo('abc')])).toBe('saved:org-web@abc')

    expect(await sandboxPathsEtag('REPO web\nFILE a')).toBe(
      await sandboxPathsEtag('REPO web\nFILE a'),
    )

    expect(await sandboxPathsEtag('REPO web\nFILE a')).not.toBe(
      await sandboxPathsEtag('REPO web\nFILE b'),
    )
  })
})

import { describe, expect, test } from 'bun:test'

import { NotFoundError } from '@pierre/sdk'

import { codeStorageRepoName, scratchRepoName } from '../codestorage/client'
import {
  findSavedWork,
  latestSave,
  listSavedFiles,
  readSavedFile,
  savedDiffs,
  type SavedWorkClient,
} from './saved-work'

const ORG = 'orgA'
const RUN = `o-${ORG}-session_1`

const glue = {
  installationId: 1,
  owner: 'acme',
  name: 'glue',
  fullName: 'acme/glue',
  defaultBranch: 'main',
  private: true,
}

const MIRROR = codeStorageRepoName(ORG, glue.fullName)
const SCRATCH = scratchRepoName(ORG, RUN)

const notFound = () => Object.assign(Object.create(NotFoundError.prototype), { message: '404' })

/** Code Storage holding `files` (path to text) on the session's branch in each named repository. */
function storage(repos: Record<string, Record<string, string>>): SavedWorkClient {
  const filesOf = (repoName: string) => {
    const files = repos[repoName]

    if (!files) {
      throw notFound()
    }

    return files
  }

  return {
    repos: {
      branches: {
        get: async ({ repo_name: repoName }) => {
          filesOf(repoName)

          return { branch: { head_sha: `sha-${repoName}` } }
        },
      },
      commits: {
        get: async () => ({ commit: { date: '2026-11-14T02:00:00Z' } }),
      },
      files: {
        async *list({ repo_name: repoName }) {
          yield { path: 'src', type: 'tree' }

          for (const path of Object.keys(filesOf(repoName))) {
            yield { path, type: 'blob' }
          }
        },
        get: async ({ repo_name: repoName, path }) => {
          const text = filesOf(repoName)[path]

          if (text === undefined) {
            throw notFound()
          }

          return new Response(text)
        },
      },
      diff: {
        get: async ({ repo_name: repoName }) => ({
          files: Object.keys(filesOf(repoName)).map((path) => ({
            raw: `diff --git a/${path} b/${path}`,
          })),
        }),
      },
    },
  }
}

describe('findSavedWork', () => {
  test("a linked repository's save is found on the mirror", async () => {
    const client = storage({ [MIRROR]: { 'a.ts': 'a' } })

    expect(await findSavedWork(client, ORG, RUN, [glue])).toEqual([
      {
        name: 'glue',
        repoName: MIRROR,
        ref: `sessions/${RUN}/w/glue`,
        sha: `sha-${MIRROR}`,
        savedAt: Date.parse('2026-11-14T02:00:00Z'),
      },
    ])
  })

  test("with no mirror, it is found in the session's own repository", async () => {
    const client = storage({ [SCRATCH]: { 'a.ts': 'a' } })
    const [saved] = await findSavedWork(client, ORG, RUN, [glue])

    expect(saved?.repoName).toBe(SCRATCH)
  })

  test('a session with no linked repository saves its demo repository', async () => {
    const client = storage({ [SCRATCH]: { 'a.ts': 'a' } })
    const [saved] = await findSavedWork(client, ORG, RUN, [])

    expect(saved?.name).toBe('demo')
    expect(saved?.ref).toBe(`sessions/${RUN}/w/demo`)
  })

  test('nothing saved is an empty answer, not an error', async () => {
    expect(await findSavedWork(storage({}), ORG, RUN, [glue])).toEqual([])
    expect(latestSave([])).toBeNull()
  })
})

describe('reading a save', () => {
  const client = storage({ [MIRROR]: { 'src/app.ts': 'export {}\n', 'README.md': '# glue\n' } })
  const saved = findSavedWork(client, ORG, RUN, [glue])

  test('files are listed under the repository, without directories', async () => {
    expect(await listSavedFiles(client, await saved)).toEqual(['glue/src/app.ts', 'glue/README.md'])
  })

  test('a file is read by its path under the worktree', async () => {
    expect(await readSavedFile(client, await saved, 'glue/src/app.ts')).toBe('export {}\n')
    expect(await readSavedFile(client, await saved, 'glue/missing.ts')).toBeNull()
    expect(await readSavedFile(client, await saved, 'other/src/app.ts')).toBeNull()
    expect(await readSavedFile(client, await saved, 'glue')).toBeNull()
  })

  test('changes come back as one diff per repository', async () => {
    expect(await savedDiffs(client, await saved)).toEqual([
      {
        name: 'glue',
        diff: 'diff --git a/src/app.ts b/src/app.ts\ndiff --git a/README.md b/README.md\n',
      },
    ])
  })
})

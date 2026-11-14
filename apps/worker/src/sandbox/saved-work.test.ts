import { describe, expect, test } from 'bun:test'

import { NotFoundError } from '@pierre/sdk'

import { codeStorageRepoName, scratchRepoName } from '../codestorage/client'
import {
  findSavedWork,
  latestSave,
  listSavedFiles,
  readSavedBaseFile,
  readSavedFile,
  savedDiffs,
  savedFileDiff,
  savedRepoSummary,
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
function storage(repos: Record<string, Record<string, string>>, withBase = true): SavedWorkClient {
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
        get: async ({ repo_name: repoName, name }) => {
          filesOf(repoName)

          // Only saves made since the base commit was recorded carry it.
          if (name.includes('/x/') && !withBase) {
            throw notFound()
          }

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
        get: async ({ repo_name: repoName, path: only, base_ref: base }) => ({
          files: Object.keys(filesOf(repoName))
            .filter((path) => !only || only.includes(path))
            .map((path) => ({
              path,
              // Against the session's starting point everything here is new; against its last
              // commit it is an edit.
              state: base ? 'A' : 'M',
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
        baseRef: `sessions/${RUN}/x/glue`,
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

  test("a repository's summary lists its files and what the session changed", async () => {
    const [repo] = await saved

    expect(repo && (await savedRepoSummary(client, repo))).toEqual({
      name: 'glue',
      files: ['src/app.ts', 'README.md'],
      changes: [
        { path: 'src/app.ts', status: 'A' },
        { path: 'README.md', status: 'A' },
      ],
    })
  })

  test("one file's changes are read by its path under the worktree", async () => {
    expect(await savedFileDiff(client, await saved, 'glue/README.md')).toBe(
      'diff --git a/README.md b/README.md\n',
    )

    expect(await savedFileDiff(client, await saved, 'other/README.md')).toBe('')
  })

  test('a file can be read as it was when the session started', async () => {
    expect(await readSavedBaseFile(client, await saved, 'glue/README.md')).toEqual({
      content: '# glue\n',
    })

    // Not there at the start: a new file.
    expect(await readSavedBaseFile(client, await saved, 'glue/new.ts')).toEqual({ content: null })
  })

  test('a save made before the base commit was recorded shows what was uncommitted', async () => {
    // It also uploaded installed dependencies, which are left out when it is read back.
    const older = storage({ [MIRROR]: { 'a.ts': 'a', 'node_modules/dep/index.js': 'x' } }, false)
    const [repo] = await findSavedWork(older, ORG, RUN, [glue])

    expect(repo?.baseRef).toBeNull()
    expect(repo && (await readSavedBaseFile(older, [repo], 'glue/a.ts'))).toBeNull()

    expect(repo && (await savedRepoSummary(older, repo))).toEqual({
      name: 'glue',
      files: ['a.ts'],
      changes: [{ path: 'a.ts', status: 'M' }],
    })
  })
})

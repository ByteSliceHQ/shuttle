import { describe, expect, test } from 'bun:test'

import type { SandboxWorkspace } from '@shuttle/api'

import type { ShuttleEnv } from '../env'
import { localSandboxName } from '../sandbox/names'
import type { SessionStacks } from '../session/stack-state'
import type { Actor } from '../tenancy/access'
import { migratedD1 } from '../testing/fake-d1'
import { fakeEnv } from '../testing/fake-env'
import { handleApi } from './handler'
import { publishedBranches } from './sandbox'

const RUN = 'session_1'
const ROOT = `/workspace/.wt/${RUN}`
const actor: Actor = { userId: 'alice', orgId: 'org_a', role: 'member', name: 'Alice', email: '' }

interface World {
  /** The sandbox the session bound, or null before it has. */
  home?: string | null
  activity?: 'working' | 'idle'
  awake?: boolean
  placement?: { kind: 'local'; userId: string; deviceId: string } | null
  /** Files in the sandbox, by absolute path. */
  files?: Record<string, string>
  /** What a command run in the sandbox prints. */
  stdout?: string
  /** Whether the machines named by local sandboxes are connected. */
  online?: boolean
  adopt?: { ok: boolean; error?: string }
  mode?: string
  /** What the session has published, by stack. */
  stacks?: SessionStacks
  /** More of what the sandbox says about the demo repository's changes. */
  summary?: Record<string, unknown>
}

/** An env whose session and sandbox objects answer from `world`, and record what was done. */
function envWith(world: World = {}, overrides: Partial<ShuttleEnv> = {}) {
  const files = { ...world.files }
  const placed: unknown[] = []
  const later: unknown[] = []
  const commands: string[] = []
  const measured: unknown[] = []

  const run = {
    getSandboxName: async () => world.home ?? null,
    getSandboxPlacement: async () => world.placement ?? null,
    getSandboxMoves: async () => ({
      pending: later.length > 0 ? { placement: later.at(-1) } : null,
      last: null,
    }),
    getSessionRepos: async () => [],
    getSessionStacks: async () => world.stacks ?? {},
    getSessionActivitySnapshot: async () => ({ activity: world.activity ?? 'idle', tail: 0 }),
    placeSandbox: async (placement: unknown) => {
      placed.push(placement)

      return { sandboxName: null, moved: null }
    },
    placeSandboxLater: async (placement: unknown) => {
      later.push(placement)

      return { ok: true }
    },
  }

  const sandbox = {
    isAwake: async () => ({ awake: world.awake ?? true }),
    isBusy: async () => ({ busy: false }),
    getMode: async () => ({ mode: 'container' }),
    describe: async () => ({ online: world.online ?? true }),
    listFiles: async () => ({ files: Object.keys(files) }),
    readFile: async (path: string) =>
      path in files
        ? { content: files[path] }
        : { content: null, missing: true, error: 'No such file' },
    writeFile: async (path: string, content: string) => {
      files[path] = content

      return { ok: true }
    },
    exec: async (command: string) => {
      commands.push(command)

      return { exitCode: 0, stdout: world.stdout ?? '', stderr: '' }
    },
    workspaceSummary: async (_runId: string, repos: unknown) => {
      measured.push(repos)

      return {
        repos: [
          {
            name: 'demo',
            files: ['a.ts'],
            changes: [{ path: 'a.ts', status: 'M' }],
            ...world.summary,
          },
        ],
        strays: [{ path: '/workspace/notes', files: 2 }],
      }
    },
    fileDiff: async () => ({ diff: '@@ one file @@' }),
    baseFile: async () => ({ content: null }),
    adoptStray: async () => world.adopt ?? { ok: true },
  }

  const env = fakeEnv({
    LOOMS_RUN: { getByName: () => run as never },
    SANDBOX: { getByName: () => sandbox } as never,
    ...(world.mode ? { SHUTTLE_WORKSPACE_MODE: world.mode } : {}),
    ...overrides,
  })

  return { env, files, placed, later, commands, measured }
}

async function call(env: ShuttleEnv, method: string, path: string, body?: unknown) {
  const response = await handleApi({
    env,
    actor,
    request: new Request(`http://worker.test/sessions/${RUN}/sandbox/${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    }),
  })

  if (!response) {
    throw new Error(`${method} ${path} is not in the contract`)
  }

  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

describe('reading a session’s files', () => {
  const world = { files: { [`${ROOT}/demo/a.ts`]: 'one', [`${ROOT}/demo/b.bin`]: 'a\0b' } }

  test('files are listed relative to the worktree', async () => {
    const { status, body } = await call(envWith(world).env, 'GET', 'files?folderId=f1')

    expect(status).toBe(200)

    expect(body).toEqual({
      root: ROOT,
      files: [
        { path: 'demo/a.ts', kind: 'file' },
        { path: 'demo/b.bin', kind: 'file' },
      ],
      mode: 'container',
      source: 'sandbox',
    })
  })

  test('a file is read by its path in the worktree', async () => {
    const { status, body } = await call(envWith(world).env, 'GET', 'file?path=demo/a.ts')

    expect(status).toBe(200)

    expect(body).toEqual({
      path: `${ROOT}/demo/a.ts`,
      content: 'one',
      binary: false,
      truncated: false,
      source: 'sandbox',
    })
  })

  test('a file that did not exist when the session started has null content', async () => {
    const { status, body } = await call(
      envWith(world).env,
      'GET',
      'file?path=demo/a.ts&version=base',
    )

    expect(status).toBe(200)
    expect(body).toEqual({ path: 'demo/a.ts', content: null, source: 'sandbox' })
  })

  test('a missing file is a 404', async () => {
    const { status, body } = await call(envWith(world).env, 'GET', 'file?path=demo/none.ts')

    expect(status).toBe(404)
    expect(body.error).toBe('No such file')
  })

  test('a file needs a path', async () => {
    const { status, body } = await call(envWith(world).env, 'GET', 'file')

    expect(status).toBe(400)
    expect(typeof body.error).toBe('string')
  })

  test('a path outside the worktree is refused', async () => {
    const { status, body } = await call(envWith(world).env, 'GET', 'file?path=/etc/passwd')

    expect(status).toBe(400)
    expect(body.error).toBe('path escapes session worktree')
  })

  test('an asleep sandbox with nothing saved has nothing to list', async () => {
    const { env } = envWith({ ...world, awake: false, mode: 'daytona' })
    const { status, body } = await call(env, 'GET', 'files')

    expect(status).toBe(200)

    expect(body).toEqual({
      root: ROOT,
      files: [],
      mode: 'container',
      source: 'asleep',
      savedAt: null,
    })

    expect((await call(env, 'GET', 'file?path=demo/a.ts')).status).toBe(404)
  })
})

describe('what a session changed', () => {
  test('every repository’s diff', async () => {
    const { status, body } = await call(envWith({ stdout: 'diff --git a b\n' }).env, 'GET', 'diff')

    expect(status).toBe(200)

    expect(body).toEqual({
      diffs: [{ cwd: `${ROOT}/demo`, name: 'demo', diff: 'diff --git a b\n' }],
      source: 'sandbox',
    })
  })

  test('one file’s diff', async () => {
    const { status, body } = await call(envWith().env, 'GET', 'diff?path=demo/a.ts')

    expect(status).toBe(200)
    expect(body).toEqual({ path: 'demo/a.ts', diff: '@@ one file @@', source: 'sandbox' })
  })

  test('a diff of a file in no repository is refused', async () => {
    const { status, body } = await call(envWith().env, 'GET', 'diff?path=elsewhere/a.ts')

    expect(status).toBe(400)
    expect(body.error).toBe('path must name a file in one of the session repositories')
  })

  test('the workspace names each repository and what changed in it', async () => {
    const { status, body } = await call(envWith({ activity: 'working' }).env, 'GET', 'workspace')

    expect(status).toBe(200)

    expect(body).toEqual({
      source: 'sandbox',
      working: true,
      holderId: null,
      repos: [
        {
          name: 'demo',
          fullName: null,
          defaultBranch: 'main',
          files: ['a.ts'],
          changes: [{ path: 'a.ts', status: 'M' }],
          head: null,
          dirty: false,
          sessionBaseSha: null,
          commits: [],
          published: [],
          comparison: {
            against: 'session',
            baseSha: null,
            baseMode: null,
            headSha: null,
            error: null,
          },
        },
      ],
      strays: [{ path: '/workspace/notes', files: 2 }],
    })
  })

  test('each repository is measured the way it was asked for', async () => {
    const { env, measured } = envWith({
      summary: {
        head: { branch: 'shuttle/x/demo', sha: 'c2' },
        dirty: true,
        sessionBaseSha: 'b0',
        commits: [{ sha: 'c2', subject: 'two', at: 2000, branches: ['shuttle/x/demo'] }],
        measure: { baseSha: 'c2', baseMode: 'merge-base', headSha: null, error: null },
      },
    })

    const { status, body } = await call(env, 'GET', 'workspace?against%5Bdemo%5D=uncommitted')

    expect(status).toBe(200)
    expect(measured).toEqual([[expect.objectContaining({ name: 'demo', against: 'uncommitted' })]])

    expect((body as SandboxWorkspace).repos[0]).toMatchObject({
      head: { branch: 'shuttle/x/demo', sha: 'c2' },
      dirty: true,
      commits: [{ sha: 'c2', subject: 'two' }],
      comparison: { against: 'uncommitted', baseSha: 'c2', error: null },
    })
  })

  test('a comparison that is not one is refused', async () => {
    const { status } = await call(envWith().env, 'GET', 'workspace?against%5Bdemo%5D=ref:a..b')

    expect(status).toBe(400)
  })

  test('a branch that is not there says so', async () => {
    const { env, commands } = envWith({
      summary: { measure: { baseSha: null, baseMode: null, headSha: null, error: 'missing' } },
    })

    const { body } = await call(env, 'GET', 'workspace?against%5Bdemo%5D=ref:develop')

    const [repo] = (body as SandboxWorkspace).repos

    expect(repo?.comparison?.error).toContain('develop')
    expect(repo?.changes).toEqual([{ path: 'a.ts', status: 'M' }])
    // The scratch repository has nowhere to fetch from.
    expect(commands).toEqual([])
  })

  test('a sandbox that fails says why', async () => {
    const { env } = envWith()

    const broken = {
      ...env,
      SANDBOX: {
        getByName: () => ({
          isAwake: async () => ({ awake: true }),
          workspaceSummary: async () => {
            throw new Error('the sandbox did not answer')
          },
        }),
      } as never,
    }

    const { status, body } = await call(broken, 'GET', 'workspace')

    expect(status).toBe(500)
    expect(body.error).toBe('the sandbox did not answer')
  })
})

describe('saving an edit', () => {
  const path = `${ROOT}/demo/a.ts`

  test('writes the file when it is as the editor found it', async () => {
    const { env, files } = envWith({ files: { [path]: 'one' } })

    const { status, body } = await call(env, 'POST', 'write', {
      path: 'demo/a.ts',
      content: 'two',
      expected: 'one',
    })

    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, path: 'demo/a.ts' })
    expect(files[path]).toBe('two')
  })

  test('is refused with a 409 when the file changed meanwhile', async () => {
    const { env, files } = envWith({ files: { [path]: 'changed' } })

    const { status, body } = await call(env, 'POST', 'write', {
      path: 'demo/a.ts',
      content: 'two',
      expected: 'one',
    })

    expect(status).toBe(409)
    expect(body.error).toMatch(/changed while you were editing/)
    expect(body.data).toEqual({ changed: true })
    expect(files[path]).toBe('changed')
  })

  test('is refused with a 409 while agents are working', async () => {
    const { env } = envWith({ files: { [path]: 'one' }, activity: 'working' })
    const { status, body } = await call(env, 'POST', 'write', { path: 'demo/a.ts', content: 'two' })

    expect(status).toBe(409)
    expect(body.error).toMatch(/Agents are working/)
  })

  test('is refused with a 409 while the sandbox is asleep', async () => {
    const { env } = envWith({ awake: false, mode: 'daytona' })
    const { status, body } = await call(env, 'POST', 'write', { path: 'demo/a.ts', content: 'two' })

    expect(status).toBe(409)
    expect(body.error).toMatch(/asleep/)
  })

  test('needs the new text', async () => {
    const { status, body } = await call(envWith().env, 'POST', 'write', { path: 'demo/a.ts' })

    expect(status).toBe(400)
    expect(typeof body.error).toBe('string')
  })

  test('needs a file in one of the repositories', async () => {
    const { status, body } = await call(envWith().env, 'POST', 'write', {
      path: '../etc/passwd',
      content: 'x',
    })

    expect(status).toBe(400)
    expect(body.error).toBe('A file in the workspace and its new text are required')
  })
})

describe('adopting a stray', () => {
  test('moves it into the workspace', async () => {
    const { status, body } = await call(envWith().env, 'POST', 'adopt', { path: '/workspace/x' })

    expect(status).toBe(200)
    expect(body).toEqual({ ok: true })
  })

  test('answers 409 with the reason when it cannot be moved', async () => {
    const { env } = envWith({ adopt: { ok: false, error: '/etc cannot be moved' } })
    const { status, body } = await call(env, 'POST', 'adopt', { path: '/etc' })

    expect(status).toBe(409)
    expect(body.error).toBe('/etc cannot be moved')
  })

  test('needs a path', async () => {
    const { status, body } = await call(envWith().env, 'POST', 'adopt', {})

    expect(status).toBe(400)
    expect(typeof body.error).toBe('string')
  })
})

describe('diagnostics', () => {
  const reply = {
    status: 'ok',
    server: 'typescript',
    diagnostics: [
      { line: 1, column: 1, endLine: 1, endColumn: 4, severity: 'error', message: 'No', code: '1' },
    ],
  }

  test('answers what the language server printed about the saved file', async () => {
    const { env } = envWith({ stdout: JSON.stringify(reply) })
    const { status, body } = await call(env, 'GET', 'diagnostics?path=demo/a.ts')

    expect(status).toBe(200)
    expect(body).toEqual(reply)
  })

  test('checks a draft, with the file named in the query and the text in the body', async () => {
    const { env, files, commands } = envWith({ stdout: JSON.stringify({ status: 'pending' }) })

    const { status, body } = await call(env, 'POST', 'diagnostics?path=demo/a.ts', {
      content: 'draft text',
    })

    expect(status).toBe(200)
    expect(body).toEqual({ status: 'pending' })
    expect(Object.values(files)).toEqual(['draft text'])
    expect(commands[0]).toContain('--text-file /tmp/shuttle-lsp-draft-')
  })

  test('a sandbox that prints nothing has no language server', async () => {
    const { body } = await call(envWith().env, 'GET', 'diagnostics?path=demo/a.ts')

    expect(body).toEqual({ status: 'unavailable', reason: 'This sandbox has no language server.' })
  })

  test('an asleep sandbox is not woken', async () => {
    const { env, commands } = envWith({ awake: false })
    const { status, body } = await call(env, 'GET', 'diagnostics?path=demo/a.ts')

    expect(status).toBe(200)
    expect(body).toEqual({ status: 'unavailable', reason: 'The sandbox is asleep.' })
    expect(commands).toEqual([])
  })

  test('a draft must be text, and the path a file in a repository', async () => {
    const { env } = envWith()
    const noText = await call(env, 'POST', 'diagnostics?path=demo/a.ts', { content: 5 })
    const noPath = await call(env, 'GET', 'diagnostics')
    const elsewhere = await call(env, 'GET', 'diagnostics?path=elsewhere/a.ts')

    expect(noText.status).toBe(400)
    expect(typeof noText.body.error).toBe('string')
    expect(noPath.status).toBe(400)
    expect(elsewhere.status).toBe(400)
    expect(elsewhere.body.error).toBe('path must be a file in one of the session repositories')
  })
})

describe('where a session is', () => {
  test('a session in the cloud', async () => {
    const { status, body } = await call(envWith().env, 'GET', 'place')

    expect(status).toBe(200)

    expect(body).toEqual({
      pending: null,
      leftBehind: null,
      personal: false,
      holderId: null,
      here: true,
      sandbox: { provider: 'memory', location: 'cloud' },
      local: null,
      cloud: { provider: 'memory', movable: false },
    })
  })

  test('a session on the caller’s machine', async () => {
    const home = localSandboxName(actor.orgId, actor.userId, 'laptop')

    const { body } = await call(
      envWith({ home, placement: { kind: 'local', userId: actor.userId, deviceId: 'laptop' } }).env,
      'GET',
      'place',
    )

    expect(body).toMatchObject({
      personal: true,
      holderId: actor.userId,
      here: true,
      sandbox: { provider: 'local', location: 'local', deviceId: 'laptop', online: true },
      local: { deviceId: 'laptop', mine: true },
    })
  })

  test('moving to a connected machine places the session there', async () => {
    const { env, placed } = envWith()
    const { status } = await call(env, 'POST', 'place', { to: 'local', deviceId: 'laptop' })

    expect(status).toBe(200)
    expect(placed).toEqual([{ kind: 'local', userId: actor.userId, deviceId: 'laptop' }])
  })

  test('a working session moves later, and the answer says where to', async () => {
    const { env, placed, later } = envWith({ activity: 'working' })
    const { status, body } = await call(env, 'POST', 'place', { to: 'local', deviceId: 'laptop' })

    expect(status).toBe(200)
    expect(body.pending).toBe('local')
    expect(placed).toEqual([])
    expect(later).toHaveLength(1)
  })

  test('a machine that is not connected is a 409', async () => {
    const { env, placed } = envWith({ online: false })
    const { status, body } = await call(env, 'POST', 'place', { to: 'local', deviceId: 'laptop' })

    expect(status).toBe(409)
    expect(body.error).toMatch(/not connected/)
    expect(placed).toEqual([])
  })

  test('only the machine’s owner moves a session off it', async () => {
    const { env } = envWith({ placement: { kind: 'local', userId: 'bob', deviceId: 'desk' } })
    const { status, body } = await call(env, 'POST', 'place', { to: 'cloud' })

    expect(status).toBe(403)
    expect(body.error).toBe("Only the machine's owner can move it")
  })

  test('a move must say where to', async () => {
    const { env } = envWith()

    for (const body of [{}, { to: 'local' }, { to: 'moon' }]) {
      const answer = await call(env, 'POST', 'place', body)

      expect(answer.status).toBe(400)
      expect(typeof answer.body.error).toBe('string')
    }
  })
})

describe('the preview address', () => {
  test('is a label, and the host when the deployment names one', async () => {
    const { env } = envWith({}, { AUTH_DB: await migratedD1(), SHUTTLE_PREVIEW_HOST: 'pre.test' })
    const first = await call(env, 'GET', 'preview')
    const second = await call(env, 'GET', 'preview')

    expect(first.status).toBe(200)
    expect(typeof first.body.label).toBe('string')
    expect(first.body.host).toBe('pre.test')
    expect(second.body).toEqual(first.body)
  })

  test('is a 503 without a database to keep labels in', async () => {
    const { status, body } = await call(envWith().env, 'GET', 'preview')

    expect(status).toBe(503)
    expect(body.error).toBe('Previews are unavailable')
  })
})

test('the terminal is not in the contract', async () => {
  const response = await handleApi({
    env: envWith().env,
    actor,
    request: new Request(`http://worker.test/sessions/${RUN}/sandbox/terminal`),
  })

  expect(response).toBeNull()
})

const layer = (branch: string, publishedTree: string, pull = true) => ({
  layer: 1,
  branch,
  parentBranch: 'main',
  pull: pull ? { number: 1, url: '', draft: true } : null,
  remoteSha: 'r',
  publishedTree,
})

describe('publishedBranches', () => {
  const stacks: SessionStacks = {
    demo: { layers: [layer('one', 't1')], native: null },
    'demo#2': { layers: [layer('two', 't2'), layer('three', '', false)], native: null },
    'demo-api': { layers: [layer('other', 't9')], native: null },
  }

  test("are every stack of the repository's, and only what has a pull request", () => {
    expect(publishedBranches(stacks, 'demo')).toEqual([
      { branch: 'one', tree: 't1' },
      { branch: 'two', tree: 't2' },
    ])
  })
})

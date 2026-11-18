import { describe, expect, test } from 'bun:test'

import { z } from 'zod'

import type { JsonValue } from '@swirls/looms/core'

import type { BridgeEvent } from '../../bridge/protocol'
import type { CredentialPayload } from '../credentials/store'
import type { SessionSandboxStub, ShuttleEnv } from '../env'
import type { Actor } from '../tenancy/access'
import { fakeEnv } from '../testing/fake-env'
import { signInFilesPresent } from '../vendor/harnesses'
import { explainDeadRun, removeSignInFiles } from './connections'
import { handleApi } from './handler'

describe('explainDeadRun', () => {
  test('a sandbox without the bridge says what to do about it', () => {
    const log = [
      'node:internal/modules/cjs/loader:1564',
      "Error: Cannot find module '/opt/shuttle-bridge/main.ts'",
      '    at Module._load (node:internal/modules/cjs/loader:1341:5)',
    ].join('\n')

    const message = explainDeadRun('Codex', log)

    expect(message).toContain('no agent bridge')
    expect(message).toContain('DAYTONA_SNAPSHOT')
  })

  test('any other death quotes the last thing the process said', () => {
    expect(explainDeadRun('Codex', 'starting\nfatal: out of memory\n\n')).toBe(
      'Codex sign-in stopped before it started: fatal: out of memory',
    )

    expect(explainDeadRun('Codex', '')).toContain('left no explanation')
  })
})

describe('sign-in files in the sandbox', () => {
  test('are checked for and removed without being read', () => {
    expect(signInFilesPresent(['.codex/auth.json'])).toBe(`test -s "$HOME"/'.codex/auth.json'`)
    expect(removeSignInFiles(['.codex/auth.json'])).toBe(`rm -f "$HOME"/'.codex/auth.json'`)
  })

  test('an agent with no sign-in file is never reported as signed in', () => {
    expect(signInFilesPresent([])).toBe('false')
  })
})

const actor: Actor = {
  userId: 'user_1',
  orgId: 'org1',
  role: 'member',
  name: 'Ada',
  email: 'ada@example.com',
}

const TEAM = { workers: true, codex: false, claudeCode: false, cursor: false, preset: 'none' }
const DEVICE = 'device_123456'

/** What the connection routes answer with, reading only the parts these tests look into. */
const ReplySchema = z.looseObject({
  error: z.string().optional(),
  machine: z.boolean().optional(),
  connected: z.boolean().optional(),
  loginId: z.string().optional(),
  harness: z.string().optional(),
  connections: z.array(z.json()).optional(),
  models: z.array(z.looseObject({ id: z.string() })).optional(),
})

/** A worker whose workspace run and sandboxes are in memory, with a record of what was asked. */
function fakeWorker(
  options: {
    env?: Partial<ShuttleEnv>
    events?: BridgeEvent[]
    files?: Record<string, string>
    /** Sign-in files that exist in the sandbox, as `exec` sees them. */
    signedInOnDisk?: boolean
    getMode?: () => Promise<{ mode: 'memory' | 'container' }>
  } = {},
) {
  const calls: unknown[][] = []
  const stored = new Map<string, CredentialPayload>()
  let defaultHarness = 'shuttle'
  let team = TEAM

  const workspace = {
    listCredentials: async () =>
      [...stored.keys()].map((harness) => ({ harness, updatedAt: 1_700_000_000_000 })),
    putCredential: async (userId: string, harness: string, payload: CredentialPayload) => {
      calls.push(['putCredential', userId, harness, payload])
      stored.set(harness, payload)
    },
    removeCredential: async (_userId: string, harness: string) => stored.delete(harness),
    getHarness: async () => ({ harness: defaultHarness }),
    setHarness: async (next: string) => ({ harness: (defaultHarness = next) }),
    getTeam: async () => ({ team }),
    setTeam: async (next: typeof TEAM) => ({ team: (team = next) }),
  }

  const sandbox = (name: string) => ({
    getMode: options.getMode ?? (async () => ({ mode: 'container' as const })),
    exec: async (command: string) => {
      calls.push(['exec', name, command])

      return { stdout: '', stderr: '', exitCode: options.signedInOnDisk ? 0 : 1 }
    },
    startAgentRun: async (input: Parameters<SessionSandboxStub['startAgentRun']>[0]) => {
      calls.push(['startAgentRun', name, input])

      return { started: true }
    },
    readAgentEvents: async (runKey: string, offset: number) => {
      calls.push(['readAgentEvents', name, runKey, offset])

      return { events: options.events ?? [], offset: offset + 10, done: true }
    },
    agentRunState: async () => ({ state: 'running' }),
    collectAgentFiles: async () => ({ files: options.files ?? {} }),
    sendAgentInput: async (runKey: string, text: string) => {
      calls.push(['sendAgentInput', name, runKey, text])

      return { ok: true }
    },
    stopAgentRun: async (runKey: string) => {
      calls.push(['stopAgentRun', name, runKey])

      return { ok: true }
    },
  })

  const env = fakeEnv({
    SHUTTLE_CREDENTIALS_KEY: 'key',
    // SAFETY: the routes under test call only the methods these fakes implement on each stub.
    LOOMS_RUN: { getByName: () => workspace } as never,
    // SAFETY: as above, for the sandbox stub.
    SANDBOX: { getByName: sandbox } as never,
    ...options.env,
  })

  const call = async (
    method: string,
    path: string,
    init: { body?: JsonValue; device?: string } = {},
  ) => {
    const headers = new Headers({ 'content-type': 'application/json' })

    if (init.device !== undefined && init.device !== '') {
      headers.set('x-shuttle-device', init.device)
    }

    const request: RequestInit = { method, headers }

    if (init.body !== undefined) {
      request.body = JSON.stringify(init.body)
    }

    const response = await handleApi({
      env,
      actor,
      // The web app sends the content type on every call, with a body or without.
      request: new Request(`https://shuttle.test/workspace/connections${path}`, request),
    })

    if (!response) {
      throw new Error(`${method} ${path} is not in the contract`)
    }

    return { status: response.status, body: ReplySchema.parse(await response.json()) }
  }

  return { call, calls, stored }
}

describe('GET /workspace/connections', () => {
  test('lists every agent, signed in or not, with the defaults for new sessions', async () => {
    const { call, stored } = fakeWorker()
    stored.set('codex', {})

    const { status, body } = await call('GET', '')

    expect(status).toBe(200)

    expect(body).toMatchObject({
      machine: false,
      defaultHarness: 'shuttle',
      defaultTeam: TEAM,
      mode: 'container',
      canStore: true,
    })

    expect(body.connections).toEqual([
      {
        harness: 'codex',
        label: 'Codex',
        connected: true,
        cloud: true,
        local: null,
        updatedAt: 1_700_000_000_000,
      },
      {
        harness: 'claude-code',
        label: 'Claude Code',
        connected: false,
        cloud: false,
        local: null,
        updatedAt: null,
      },
      {
        harness: 'cursor',
        label: 'Cursor',
        connected: false,
        cloud: false,
        local: null,
        updatedAt: null,
      },
    ])
  })

  test('asked from the desktop app, looks on that machine as well', async () => {
    const { call, calls } = fakeWorker({ signedInOnDisk: true })
    const { body } = await call('GET', '', { device: DEVICE })

    expect(body.machine).toBe(true)

    expect(body.connections?.[0]).toMatchObject({
      harness: 'codex',
      connected: true,
      cloud: false,
      local: true,
    })

    expect(calls[0]).toEqual([
      'exec',
      `local:org1:user_1:${DEVICE}`,
      `test -s "$HOME"/'.codex/auth.json'`,
    ])
  })

  test('a deployment that cannot run the agents says what it needs', async () => {
    const { call } = fakeWorker({
      getMode: () => Promise.reject(new Error('container-mode-required')),
    })

    const { status, body } = await call('GET', '')

    expect(status).toBe(501)
    expect(body.error).toBe('Connecting a subscription needs SHUTTLE_WORKSPACE_MODE=container.')
  })
})

describe('PUT /workspace/connections/default', () => {
  test('sets either part and leaves the other as it was', async () => {
    const { call } = fakeWorker()

    expect((await call('PUT', '/default', { body: { harness: 'codex' } })).body).toEqual({
      defaultHarness: 'codex',
      defaultTeam: TEAM,
    })

    // A preset only stands when both agents it names are on the team.
    const team = { ...TEAM, codex: true, preset: 'codex-builds-claude-reviews' }

    expect((await call('PUT', '/default', { body: { team } })).body).toEqual({
      defaultHarness: 'codex',
      defaultTeam: { ...team, preset: 'none' },
    })
  })

  test('refuses a harness it does not know, and a request that sets nothing', async () => {
    const { call } = fakeWorker()

    expect((await call('PUT', '/default', { body: { harness: 'emacs' } })).status).toBe(400)

    expect(await call('PUT', '/default', { body: {} })).toMatchObject({
      status: 400,
      body: { error: 'unknown harness or invalid team' },
    })
  })
})

describe('DELETE /workspace/connections/{harness}', () => {
  test('forgets the stored sign-in', async () => {
    const { call, stored, calls } = fakeWorker()
    stored.set('codex', {})

    expect((await call('DELETE', '/codex')).body).toEqual({ removed: true })
    expect((await call('DELETE', '/codex')).body).toEqual({ removed: false })
    expect(calls).toEqual([])
  })

  test('on a machine, deletes the files there and leaves the cloud sign-in', async () => {
    const { call, stored, calls } = fakeWorker()
    stored.set('codex', {})

    expect((await call('DELETE', '/codex', { device: DEVICE })).body).toEqual({ removed: true })
    expect(stored.has('codex')).toBe(true)

    expect(calls).toEqual([
      ['exec', `local:org1:user_1:${DEVICE}`, `rm -f "$HOME"/'.codex/auth.json'`],
    ])
  })

  test('an agent Shuttle cannot sign in to is not found', async () => {
    const { call } = fakeWorker()

    for (const harness of ['shuttle', 'emacs', 'acp:custom']) {
      expect(await call('DELETE', `/${harness}`)).toMatchObject({
        status: 404,
        body: { error: 'unknown harness' },
      })
    }
  })
})

describe('GET /workspace/connections/{harness}/models', () => {
  test('offers the built-in list for an agent that cannot list its own', async () => {
    const { call } = fakeWorker()
    const { status, body } = await call('GET', '/claude-code/models')

    expect(status).toBe(200)
    expect(body.harness).toBe('claude-code')
    expect(body.models?.map((model) => model.id)).toContain('sonnet')
  })
})

describe('signing in', () => {
  const LOGIN = 'login_codex_abc'

  test('starts the vendor CLI in the sandbox for sign-ins', async () => {
    const { call, calls } = fakeWorker()
    const { status, body } = await call('POST', '/codex/login')

    expect(status).toBe(200)
    expect(body.loginId).toMatch(/^login_codex_[0-9a-f-]{36}$/)

    expect(calls).toEqual([
      [
        'startAgentRun',
        'connections:user_1',
        { runKey: body.loginId, mode: 'login', request: { harness: 'codex' } },
      ],
    ])
  })

  test('does not start without a key to store the sign-in with', async () => {
    const { call, calls } = fakeWorker({ env: { SHUTTLE_CREDENTIALS_KEY: ' ' } })
    const { status, body } = await call('POST', '/codex/login')

    expect(status).toBe(503)
    expect(body.error).toContain('SHUTTLE_CREDENTIALS_KEY is not set')
    expect(calls).toEqual([])
  })

  test('passes on what the CLI printed, from the offset asked for', async () => {
    const prompt = { type: 'login_prompt', url: 'https://vendor.test', code: 'ABCD', seq: 1, at: 5 }
    // SAFETY: the fixture has every field of a `login_prompt` event.
    const { call, calls } = fakeWorker({ events: [prompt as BridgeEvent] })

    expect((await call('GET', `/codex/login/${LOGIN}?offset=7`)).body).toEqual({
      events: [prompt],
      offset: 17,
      done: true,
      connected: false,
    })

    expect(calls).toEqual([['readAgentEvents', 'connections:user_1', LOGIN, 7]])
  })

  test('stores the sign-in files once the CLI reports success', async () => {
    // SAFETY: the fixture has every field of a `login_done` event.
    const done = { type: 'login_done', success: true, seq: 2, at: 9 } as BridgeEvent
    const files = { '.codex/auth.json': 'secret' }
    const { call, stored } = fakeWorker({ events: [done], files })

    expect((await call('GET', `/codex/login/${LOGIN}`)).body).toMatchObject({
      events: [done],
      connected: true,
    })

    expect(stored.get('codex')).toEqual({ files })
  })

  test('a success that left nothing to store is not a connection', async () => {
    // SAFETY: the fixture has every field of a `login_done` event.
    const done = { type: 'login_done', success: true, seq: 2, at: 9 } as BridgeEvent
    const { call, stored } = fakeWorker({ events: [done] })

    expect((await call('GET', `/codex/login/${LOGIN}`)).body).toMatchObject({
      connected: false,
      error: 'Codex reported success but left no sign-in files to store.',
    })

    expect(stored.size).toBe(0)
  })

  test('on a machine the sign-in stays on its disk and is not recorded in the cloud', async () => {
    // SAFETY: the fixture has every field of a `login_done` event.
    const done = { type: 'login_done', success: true, seq: 2, at: 9 } as BridgeEvent
    const { call, stored } = fakeWorker({ events: [done], signedInOnDisk: true })
    const { body } = await call('GET', `/codex/login/${LOGIN}`, { device: DEVICE })

    expect(body.connected).toBe(true)
    expect(stored.size).toBe(0)
  })

  test('refuses a sign-in id or an offset that could not be one', async () => {
    const { call, calls } = fakeWorker()

    expect((await call('GET', '/codex/login/no%20spaces')).status).toBe(400)
    expect((await call('GET', `/codex/login/${LOGIN}?offset=-1`)).status).toBe(400)
    expect(calls).toEqual([])
  })

  test('passes a code back to the CLI, and needs one to pass', async () => {
    const { call, calls } = fakeWorker()

    expect(await call('POST', `/codex/login/${LOGIN}/code`, { body: { code: ' 1234 ' } })).toEqual({
      status: 200,
      body: { ok: true },
    })

    expect((await call('POST', `/codex/login/${LOGIN}/code`, { body: { code: ' ' } })).status).toBe(
      400,
    )

    expect((await call('POST', `/codex/login/${LOGIN}/code`)).status).toBe(400)
    expect(calls).toEqual([['sendAgentInput', 'connections:user_1', LOGIN, '1234']])
  })

  test('cancelling stops the CLI', async () => {
    const { call, calls } = fakeWorker()

    expect((await call('POST', `/codex/login/${LOGIN}/cancel`)).body).toEqual({ ok: true })
    expect(calls).toEqual([['stopAgentRun', 'connections:user_1', LOGIN]])
  })
})

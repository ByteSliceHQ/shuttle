import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { claudeSignedIn, runClaudeLogin, runClaudeTurn } from './claude'
import type { BridgeEventBody, BridgeTurnRequest } from './protocol'

const bin = join(import.meta.dir, 'testing/fake-claude.ts')
const request: BridgeTurnRequest = { harness: 'claude-code', prompt: 'Fix it', cwd: tmpdir() }

async function withEnv<T>(env: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))

  Object.assign(process.env, env)

  try {
    return await run()
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

async function turn(
  mode: string,
  overrides: Partial<BridgeTurnRequest> = {},
  signal = new AbortController().signal,
): Promise<BridgeEventBody[]> {
  const events: BridgeEventBody[] = []

  await withEnv({ FAKE_CLAUDE_MODE: mode }, () =>
    runClaudeTurn({ ...request, ...overrides }, (event) => events.push(event), signal, { bin }),
  )

  return events
}

describe('claude turn', () => {
  test('maps a Claude Code stream onto bridge events', async () => {
    expect(await turn('turn')).toEqual([
      { type: 'thread', vendorThreadId: 'sess_new', model: 'claude-test' },
      { type: 'thought_delta', delta: 'Look at the file.' },
      { type: 'thought', text: 'Look at the file.' },
      { type: 'tool_started', id: 'tool_1', kind: 'command', title: 'ls' },
      { type: 'tool_started', id: 'tool_2', kind: 'file_change', title: 'Edit src/a.ts' },
      {
        type: 'tool_finished',
        id: 'tool_1',
        kind: 'command',
        title: 'ls',
        status: 'completed',
        output: 'a.ts',
      },
      {
        type: 'tool_finished',
        id: 'tool_2',
        kind: 'file_change',
        title: 'Edit src/a.ts',
        status: 'failed',
        output: 'no match',
      },
      { type: 'text_delta', delta: 'Done.' },
      { type: 'message', text: 'Done.' },
      { type: 'usage', input: 100, output: 5 },
      { type: 'turn_done', status: 'completed', text: 'Done.' },
    ])
  })

  test('resumes the session it is given', async () => {
    expect((await turn('turn', { vendorThreadId: 'sess_old' }))[0]).toEqual({
      type: 'thread',
      vendorThreadId: 'sess_old',
      model: 'claude-test',
    })
  })

  test('starts a new session when the old one no longer exists', async () => {
    const events = await turn('turn', { vendorThreadId: 'lost' })

    expect(events[0]).toMatchObject({ type: 'thread', vendorThreadId: 'sess_new' })
    expect(events.at(-1)).toMatchObject({ type: 'turn_done', status: 'completed' })
  })

  test('reports a signed-out agent as a failed turn with its message', async () => {
    expect((await turn('unauthenticated')).at(-1)).toEqual({
      type: 'turn_done',
      status: 'failed',
      text: '',
      error: 'Not logged in · Please run /login',
    })
  })

  test('an abort interrupts the turn', async () => {
    const controller = new AbortController()
    const pending = turn('hang', {}, controller.signal)

    setTimeout(() => controller.abort(), 200)

    expect((await pending).at(-1)).toEqual({ type: 'turn_done', status: 'interrupted', text: '' })
  })

  test('a missing binary ends the turn as failed', async () => {
    const events: BridgeEventBody[] = []

    await runClaudeTurn(request, (event) => events.push(event), new AbortController().signal, {
      bin: '/nonexistent/shuttle-fake-claude',
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'turn_done', status: 'failed' })
  })
})

async function login(code: string): Promise<{ events: BridgeEventBody[]; signedIn: boolean }> {
  const events: BridgeEventBody[] = []
  const home = mkdtempSync(join(tmpdir(), 'shuttle-claude-home-'))

  return withEnv({ HOME: home }, async () => {
    await runClaudeLogin(
      (event) => events.push(event),
      new AbortController().signal,
      async () => code,
      { bin },
    )

    return { events, signedIn: await claudeSignedIn({ bin }) }
  })
}

describe('claude login', () => {
  test('shows the link, passes the pasted code to Claude Code, and reports success', async () => {
    const { events, signedIn } = await login(' good-code ')

    expect(events).toEqual([
      {
        type: 'login_prompt',
        url: 'https://example.test/oauth?state=abc',
        code: '',
        needsCode: true,
      },
      { type: 'login_done', success: true },
    ])

    expect(signedIn).toBe(true)
  })

  test('reports failure when Claude Code rejects the code', async () => {
    const { events, signedIn } = await login('bad-code')

    expect(events.at(-1)).toMatchObject({ type: 'login_done', success: false })
    expect(signedIn).toBe(false)
  })

  test('an abort cancels sign-in', async () => {
    const controller = new AbortController()
    const events: BridgeEventBody[] = []

    const pending = runClaudeLogin(
      (event) => events.push(event),
      controller.signal,
      () => new Promise<string>(() => {}),
      { bin },
    )

    setTimeout(() => controller.abort(), 300)
    await pending

    expect(events.at(-1)).toEqual({
      type: 'login_done',
      success: false,
      error: 'sign-in was cancelled',
    })
  })
})

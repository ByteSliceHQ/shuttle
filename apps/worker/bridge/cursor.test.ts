import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { cursorSignedIn, listCursorModels, runCursorLogin, runCursorTurn } from './cursor'
import type { BridgeEventBody, BridgeTurnRequest } from './protocol'

const bin = join(import.meta.dir, 'testing/fake-cursor.ts')
const request: BridgeTurnRequest = { harness: 'cursor', prompt: 'Fix it', cwd: tmpdir() }

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

  await withEnv({ FAKE_CURSOR_MODE: mode }, () =>
    runCursorTurn({ ...request, ...overrides }, (event) => events.push(event), signal, { bin }),
  )

  return events
}

describe('cursor turn', () => {
  test('maps a Cursor stream onto bridge events', async () => {
    expect(await turn('turn')).toEqual([
      { type: 'thread', vendorThreadId: 'sess_new', model: 'composer-test' },
      { type: 'text_delta', delta: 'Looking' },
      { type: 'text_delta', delta: '…' },
      { type: 'tool_started', id: 'call_1', kind: 'other', title: 'Read README.md' },
      {
        type: 'tool_finished',
        id: 'call_1',
        kind: 'other',
        title: 'Read README.md',
        status: 'completed',
        output: '12 lines',
      },
      { type: 'tool_started', id: 'call_2', kind: 'file_change', title: 'Write summary.txt' },
      {
        type: 'tool_finished',
        id: 'call_2',
        kind: 'file_change',
        title: 'Write summary.txt',
        status: 'completed',
        output: 'created 3 lines',
      },
      { type: 'text_delta', delta: 'Done.' },
      { type: 'message', text: 'Done.' },
      { type: 'turn_done', status: 'completed', text: 'Looking…Done.' },
    ])
  })

  test('resumes the session it is given', async () => {
    expect((await turn('turn', { vendorThreadId: 'sess_old' }))[0]).toEqual({
      type: 'thread',
      vendorThreadId: 'sess_old',
      model: 'composer-test',
    })
  })

  test('starts a new session when the old one no longer exists', async () => {
    const events = await turn('turn', { vendorThreadId: 'lost' })

    expect(events[0]).toMatchObject({ type: 'thread', vendorThreadId: 'sess_new' })
    expect(events.at(-1)).toMatchObject({ type: 'turn_done', status: 'completed' })
  })

  test('opens a new conversation with the standing instructions', async () => {
    const events = await turn('echo-prompt', { instructions: 'Detach dev servers.' })

    expect(events.at(-1)).toEqual({
      type: 'turn_done',
      status: 'completed',
      text: '<shuttle_instructions>\nDetach dev servers.\n</shuttle_instructions>\n\nFix it',
    })
  })

  test('a resumed conversation already has its instructions', async () => {
    const events = await turn('echo-prompt', {
      instructions: 'Detach dev servers.',
      vendorThreadId: 'sess_old',
    })

    expect(events.at(-1)).toEqual({ type: 'turn_done', status: 'completed', text: 'Fix it' })
  })

  test('a shell left running in the background does not keep the turn open', async () => {
    const events = await turn('background-shell')

    expect(events.at(-1)).toEqual({ type: 'turn_done', status: 'completed', text: 'Server is up.' })
  })

  test('reports a signed-out agent as a failed turn with its message', async () => {
    expect((await turn('unauthenticated')).at(-1)).toEqual({
      type: 'turn_done',
      status: 'failed',
      text: '',
      error: 'Not authenticated. Run `agent login`.',
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

    await runCursorTurn(request, (event) => events.push(event), new AbortController().signal, {
      bin: '/nonexistent/shuttle-fake-cursor',
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'turn_done', status: 'failed' })
  })
})

describe('cursor login', () => {
  async function login(mode = 'turn'): Promise<{ events: BridgeEventBody[]; signedIn: boolean }> {
    const events: BridgeEventBody[] = []
    const home = mkdtempSync(join(tmpdir(), 'shuttle-cursor-home-'))

    return withEnv({ HOME: home, FAKE_CURSOR_MODE: mode }, async () => {
      await runCursorLogin((event) => events.push(event), new AbortController().signal, { bin })

      return { events, signedIn: await cursorSignedIn({ bin }) }
    })
  }

  test('shows the link and reports success after browser auth', async () => {
    const { events, signedIn } = await login()

    expect(events).toEqual([
      {
        type: 'login_prompt',
        url: 'https://example.test/cursor-login?state=xyz',
        code: '',
        needsCode: false,
      },
      { type: 'login_done', success: true },
    ])

    expect(signedIn).toBe(true)
  })

  test('reports failure when Cursor rejects the sign-in', async () => {
    const { events, signedIn } = await login('reject-login')

    expect(events.at(-1)).toMatchObject({ type: 'login_done', success: false })
    expect(signedIn).toBe(false)
  })

  test('an abort cancels sign-in', async () => {
    const controller = new AbortController()
    const events: BridgeEventBody[] = []
    const home = mkdtempSync(join(tmpdir(), 'shuttle-cursor-home-'))

    await withEnv({ HOME: home, FAKE_CURSOR_MODE: 'hang' }, async () => {
      const pending = runCursorLogin((event) => events.push(event), controller.signal, { bin })

      setTimeout(() => controller.abort(), 300)
      await pending
    })

    expect(events.at(-1)).toEqual({
      type: 'login_done',
      success: false,
      error: 'sign-in was cancelled',
    })
  })
})

describe('cursor models', () => {
  test('lists the models Cursor shows for the account', async () => {
    expect(await listCursorModels({ bin })).toEqual([
      { id: 'composer-2.5', label: 'Composer 2.5', description: '', efforts: [], isDefault: true },
      { id: 'auto', label: 'Auto', description: '', efforts: [] },
    ])
  })
})

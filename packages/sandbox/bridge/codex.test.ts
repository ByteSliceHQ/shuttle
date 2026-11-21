import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import { listCodexModels, runCodexLogin, runCodexTurn, unwrapShell } from './codex'
import type { BridgeEventBody, BridgeTurnRequest } from './protocol'

const fake = [process.execPath, join(import.meta.dir, 'testing/fake-codex.ts')]

const request: BridgeTurnRequest = {
  harness: 'codex',
  prompt: 'Run the tests',
  cwd: '/workspace/repos/demo',
}

async function withMode<T>(mode: string, run: () => Promise<T>): Promise<T> {
  process.env.FAKE_CODEX_MODE = mode

  try {
    return await run()
  } finally {
    delete process.env.FAKE_CODEX_MODE
  }
}

async function turn(
  mode: string,
  overrides: Partial<BridgeTurnRequest> = {},
  signal = new AbortController().signal,
): Promise<BridgeEventBody[]> {
  const events: BridgeEventBody[] = []

  await withMode(mode, () =>
    runCodexTurn({ ...request, ...overrides }, (event) => events.push(event), signal, {
      command: fake,
      interruptGraceMs: 2_000,
    }),
  )

  return events
}

describe('codex turn', () => {
  test('maps a Codex turn onto bridge events', async () => {
    expect(await turn('turn')).toEqual([
      { type: 'thread', vendorThreadId: 'thr_new', model: 'gpt-test' },
      { type: 'thought_delta', delta: 'Checking the tests.' },
      { type: 'thought', text: 'Checking the tests.' },
      { type: 'tool_started', id: 'item_web', kind: 'web_search', title: 'bun test docs' },
      {
        type: 'tool_finished',
        id: 'item_web',
        kind: 'web_search',
        title: 'bun test docs',
        status: 'completed',
      },
      { type: 'tool_started', id: 'item_cmd', kind: 'command', title: 'bun test' },
      {
        type: 'tool_finished',
        id: 'item_cmd',
        kind: 'command',
        title: 'bun test',
        status: 'completed',
        output: '3 pass',
        exitCode: 0,
      },
      { type: 'tool_started', id: 'item_patch', kind: 'file_change', title: 'src/a.ts, src/b.ts' },
      {
        type: 'tool_finished',
        id: 'item_patch',
        kind: 'file_change',
        title: 'src/a.ts, src/b.ts',
        status: 'failed',
      },
      { type: 'text_delta', delta: 'All ' },
      { type: 'text_delta', delta: 'done.' },
      { type: 'message', text: 'All done.' },
      { type: 'usage', input: 120, output: 30, contextWindow: 400_000 },
      { type: 'turn_done', status: 'completed', text: 'All done.' },
    ])
  })

  test('continues the vendor thread it is given', async () => {
    const events = await turn('turn', { vendorThreadId: 'thr_existing' })

    expect(events[0]).toEqual({ type: 'thread', vendorThreadId: 'thr_existing' })
    expect(events.at(-1)).toMatchObject({ type: 'turn_done', status: 'completed' })
  })

  test('an abort interrupts the turn', async () => {
    const controller = new AbortController()
    const pending = turn('hang', {}, controller.signal)

    setTimeout(() => controller.abort(), 150)

    expect((await pending).at(-1)).toEqual({ type: 'turn_done', status: 'interrupted', text: '' })
  })

  test('a crashed agent ends the turn as failed', async () => {
    const last = (await turn('crash')).at(-1)

    expect(last).toMatchObject({ type: 'turn_done', status: 'failed' })
    expect(last && 'error' in last ? last.error : '').toContain('exited')
  })

  test('a missing binary ends the turn as failed', async () => {
    const events: BridgeEventBody[] = []

    await runCodexTurn(request, (event) => events.push(event), new AbortController().signal, {
      command: ['/nonexistent/shuttle-fake-codex'],
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'turn_done', status: 'failed' })
  })
})

describe('codex models', () => {
  test('lists the models Codex shows in its own picker', async () => {
    expect(await listCodexModels({ command: fake })).toEqual([
      {
        id: 'gpt-test',
        label: 'GPT Test',
        description: 'The workhorse.',
        efforts: ['low', 'high'],
        defaultEffort: 'low',
        isDefault: true,
      },
    ])
  })
})

describe('unwrapShell', () => {
  test('shows the script Codex ran, not its shell wrapper', () => {
    expect(unwrapShell("/bin/bash -lc 'npm run build && git status'")).toBe(
      'npm run build && git status',
    )

    expect(unwrapShell('/bin/bash -lc "echo \\"hi\\" && pwd"')).toBe('echo "hi" && pwd')
    expect(unwrapShell('git status')).toBe('git status')
  })
})

describe('codex login', () => {
  test('surfaces the device code and reports success', async () => {
    const events: BridgeEventBody[] = []

    await withMode('login', () =>
      runCodexLogin((event) => events.push(event), new AbortController().signal, {
        command: fake,
      }),
    )

    expect(events).toEqual([
      { type: 'login_prompt', url: 'https://example.test/device', code: 'ABCD-1234' },
      { type: 'login_done', success: true },
    ])
  })

  test('an abort cancels sign-in', async () => {
    const controller = new AbortController()
    const events: BridgeEventBody[] = []

    const pending = withMode('hang', () =>
      runCodexLogin((event) => events.push(event), controller.signal, { command: fake }),
    )

    setTimeout(() => controller.abort(), 150)
    await pending

    expect(events.at(-1)).toEqual({
      type: 'login_done',
      success: false,
      error: 'sign-in was cancelled',
    })
  })
})

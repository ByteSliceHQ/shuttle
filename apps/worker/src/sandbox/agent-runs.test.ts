import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { BridgeEvent } from '../../bridge/protocol'
import {
  agentRunState,
  collectAgentFiles,
  readAgentEvents,
  readAgentLog,
  startAgentRun,
  stopAgentRun,
  type AgentRunContainer,
  type AgentRunOptions,
} from './agent-runs'

const bridgeDir = join(import.meta.dir, '../../bridge')

/** Runs container commands on this machine, with a throwaway home directory. */
function localContainer(mode: string): {
  container: AgentRunContainer
  options: AgentRunOptions
  home: string
} {
  const home = mkdtempSync(join(tmpdir(), 'shuttle-agent-home-'))
  const root = mkdtempSync(join(tmpdir(), 'shuttle-agent-runs-'))

  const container: AgentRunContainer = {
    exec: async (argv, options) => {
      const child = Bun.spawn(argv, {
        env: {
          ...process.env,
          HOME: home,
          SHUTTLE_CODEX_BIN: join(bridgeDir, 'testing/fake-codex.ts'),
          FAKE_CODEX_MODE: mode,
          ...options?.env,
        },
        stdin: options?.stdin ?? 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      })

      return {
        output: async () => ({
          stdout: await new Response(child.stdout).arrayBuffer(),
          stderr: await new Response(child.stderr).arrayBuffer(),
          exitCode: await child.exited,
        }),
      }
    },
  }

  return {
    container,
    home,
    options: { root, bridge: join(bridgeDir, 'main.ts'), runtime: [process.execPath] },
  }
}

const request = { harness: 'codex', prompt: 'Run the tests', cwd: '/tmp' } as const

async function follow(
  container: AgentRunContainer,
  runKey: string,
  options: AgentRunOptions,
): Promise<BridgeEvent[]> {
  const events: BridgeEvent[] = []
  let offset = 0

  for (let attempt = 0; attempt < 200; attempt += 1) {
    const page = await readAgentEvents(container, runKey, offset, options)

    events.push(...page.events)
    offset = page.offset

    if (page.done) {
      return events
    }

    await Bun.sleep(50)
  }

  throw new Error(`run ${runKey} did not finish; got ${JSON.stringify(events)}`)
}

describe('agent runs', () => {
  test('runs a detached turn and reads its events by offset', async () => {
    const { container, options } = localContainer('turn')

    expect(await agentRunState(container, 'turn_1', options)).toBe('missing')

    expect(
      await startAgentRun(container, { runKey: 'turn_1', mode: 'turn', request }, options),
    ).toEqual({ started: true })

    const events = await follow(container, 'turn_1', options)

    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1))
    expect(events[0]).toMatchObject({ type: 'thread', vendorThreadId: 'thr_new' })

    expect(events.at(-1)).toMatchObject({
      type: 'turn_done',
      status: 'completed',
      text: 'All done.',
    })

    // A reader that restarts from an earlier offset gets the same tail again.
    const middle = await readAgentEvents(container, 'turn_1', 0, options)
    const again = await readAgentEvents(container, 'turn_1', middle.offset, options)

    expect(middle.events).toEqual(events)
    expect(again).toEqual({ events: [], offset: middle.offset, done: false })
  })

  test('starting the same run twice does not run the agent twice', async () => {
    const { container, options } = localContainer('turn')
    const input = { runKey: 'turn_once', mode: 'turn', request } as const

    expect(await startAgentRun(container, input, options)).toEqual({ started: true })
    expect(await startAgentRun(container, input, options)).toEqual({ started: false })

    const events = await follow(container, 'turn_once', options)

    expect(events.filter((event) => event.type === 'turn_done')).toHaveLength(1)
  })

  test('stopping a run interrupts it and still ends the event file', async () => {
    const { container, options } = localContainer('hang')

    await startAgentRun(container, { runKey: 'turn_hang', mode: 'turn', request }, options)

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const page = await readAgentEvents(container, 'turn_hang', 0, options)

      if (page.events.length > 0) {
        break
      }

      await Bun.sleep(50)
    }

    expect(await agentRunState(container, 'turn_hang', options)).toBe('running')

    await stopAgentRun(container, 'turn_hang', options)

    const events = await follow(container, 'turn_hang', options)

    expect(events.at(-1)).toMatchObject({ type: 'turn_done', status: 'interrupted' })

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await agentRunState(container, 'turn_hang', options)) === 'exited') {
        break
      }

      await Bun.sleep(50)
    }

    expect(await agentRunState(container, 'turn_hang', options)).toBe('exited')
  })

  test('places sign-in files before the run and reads them back after', async () => {
    const { container, options, home } = localContainer('turn')
    const auth = btoa('{"token":"abc"}')

    await startAgentRun(
      container,
      { runKey: 'turn_files', mode: 'turn', request, files: { '.codex/auth.json': auth } },
      options,
    )

    expect(readFileSync(join(home, '.codex/auth.json'), 'utf8')).toBe('{"token":"abc"}')

    expect(
      await collectAgentFiles(container, ['.codex/auth.json', '.codex/none.json'], options),
    ).toEqual({ '.codex/auth.json': auth })

    await follow(container, 'turn_files', options)
  })

  test('reads back sign-in files larger than a pipe buffer', async () => {
    const { container, options, home } = localContainer('turn')
    const big = 'x'.repeat(400_000)

    writeFileSync(join(home, 'big.json'), big)

    const files = await collectAgentFiles(container, ['big.json'], options)

    expect(atob(files['big.json'] ?? '')).toBe(big)
  })

  test('keeps the request and secrets out of the launch command line', async () => {
    const { container, options } = localContainer('turn')
    const seen: string[][] = []

    const spy: AgentRunContainer = {
      exec: (argv, execOptions) => {
        seen.push(argv)
        return container.exec(argv, execOptions)
      },
    }

    await startAgentRun(
      spy,
      {
        runKey: 'turn_secret',
        mode: 'turn',
        request: { ...request, prompt: 'prompt-marker' },
        env: { OPENAI_API_KEY: 'key-marker' },
        files: { '.codex/auth.json': btoa('file-marker') },
      },
      options,
    )

    const commandLines = JSON.stringify(seen)

    expect(commandLines).not.toContain('prompt-marker')
    expect(commandLines).not.toContain('key-marker')
    expect(commandLines).not.toContain(btoa('file-marker'))

    await follow(container, 'turn_secret', options)
  })

  test('rejects a run key that could escape the runs directory', async () => {
    const { container, options } = localContainer('turn')

    expect(readAgentEvents(container, '../etc', 0, options)).rejects.toThrow(
      'invalid agent run key',
    )

    expect(existsSync(join(options.root ?? '', '..', 'etc', 'request.json'))).toBe(false)
  })

  test('a bridge that dies on the way up is seen as gone, with the reason in its log', async () => {
    const { container, options } = localContainer('ok')
    const broken = { ...options, bridge: '/nowhere/shuttle-bridge/main.ts' }

    await startAgentRun(container, { runKey: 'turn_dead', mode: 'turn', request }, broken)

    // It never writes its own pid, which used to read as "still starting" for ever.
    let state = await agentRunState(container, 'turn_dead', broken)

    for (let i = 0; i < 50 && state !== 'exited'; i++) {
      await Bun.sleep(20)
      state = await agentRunState(container, 'turn_dead', broken)
    }

    expect(state).toBe('exited')
    expect(await readAgentLog(container, 'turn_dead', broken)).toContain('shuttle-bridge')
    expect((await readAgentEvents(container, 'turn_dead', 0, broken)).events).toEqual([])
  })
})

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { runClaudeLogin, runClaudeTurn } from './claude.ts'
import { listCodexModels, runCodexLogin, runCodexTurn } from './codex.ts'
import { listCursorModels, runCursorLogin, runCursorTurn } from './cursor.ts'
import { collectHomeFiles, seedHomeFiles } from './home.ts'
import {
  BRIDGE_EVENTS_FILE,
  BRIDGE_INPUT_FILE,
  BRIDGE_PID_FILE,
  BRIDGE_REQUEST_FILE,
  isTerminalBridgeEvent,
  type BridgeEmit,
  type BridgeEventBody,
  type BridgeLoginRequest,
  type BridgeReadInput,
  type BridgeTurnRequest,
} from './protocol.ts'

/**
 * shuttle-agent-bridge: runs one vendor agent turn, or one sign-in, inside the sandbox container.
 *
 *   node main.ts turn  --dir <dir>
 *   node main.ts login --dir <dir>
 *   node main.ts seed                 (sign-in files as JSON on stdin)
 *   node main.ts collect --paths a,b  (sign-in files as JSON on stdout)
 *   node main.ts models --harness codex  (the agent's models as JSON on stdout)
 *
 * `<dir>` holds `request.json`. The bridge appends events to `events.jsonl` there and always ends
 * the file with a terminal event, so a reader never waits on a run that has died. SIGTERM
 * interrupts the run.
 */

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

/** Appends events synchronously so a reader sees every line whole, and none after the last. */
export function createEventWriter(dir: string): { emit: BridgeEmit; ended: () => boolean } {
  const path = join(dir, BRIDGE_EVENTS_FILE)
  let seq = 0
  let ended = false

  return {
    emit: (event: BridgeEventBody) => {
      if (ended) {
        return
      }

      seq += 1
      ended = isTerminalBridgeEvent(event)
      appendFileSync(path, `${JSON.stringify({ ...event, seq, at: Date.now() })}\n`)
    },
    ended: () => ended,
  }
}

/** Waits for the Worker to write the user's reply into the run directory. */
export function createInputReader(dir: string, signal: AbortSignal): BridgeReadInput {
  const path = join(dir, BRIDGE_INPUT_FILE)

  return () =>
    new Promise<string>((resolve, reject) => {
      const check = () => {
        if (signal.aborted) {
          clearInterval(timer)
          reject(new Error('aborted'))
          return
        }

        if (existsSync(path)) {
          clearInterval(timer)
          resolve(readFileSync(path, 'utf8'))
        }
      }

      const timer = setInterval(check, 250)
    })
}

async function runTurn(request: BridgeTurnRequest, emit: BridgeEmit, signal: AbortSignal) {
  if (request.harness === 'codex') {
    return runCodexTurn(request, emit, signal)
  }

  if (request.harness === 'claude-code') {
    return runClaudeTurn(request, emit, signal)
  }

  if (request.harness === 'cursor') {
    return runCursorTurn(request, emit, signal)
  }

  emit({
    type: 'turn_done',
    status: 'failed',
    text: '',
    error: `the ${request.harness} harness is not supported yet`,
  })
}

async function runLogin(
  request: BridgeLoginRequest,
  emit: BridgeEmit,
  signal: AbortSignal,
  readInput: BridgeReadInput,
) {
  if (request.harness === 'codex') {
    return runCodexLogin(emit, signal)
  }

  if (request.harness === 'claude-code') {
    return runClaudeLogin(emit, signal, readInput)
  }

  if (request.harness === 'cursor') {
    return runCursorLogin(emit, signal)
  }

  emit({
    type: 'login_done',
    success: false,
    error: `sign-in for the ${request.harness} harness is not supported yet`,
  })
}

/** Writes to stdout and waits for it. Exiting first cuts a pipe off at its buffer size. */
function print(output: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    process.stdout.write(output, (error) => (error ? reject(error) : resolve()))
  })
}

async function main(): Promise<void> {
  const mode = process.argv[2]
  const dir = argument('dir')

  if (mode === 'seed') {
    seedHomeFiles(homedir(), JSON.parse(readFileSync(0, 'utf8')))
    return
  }

  if (mode === 'collect') {
    const paths = (argument('paths') ?? '').split(',').filter(Boolean)

    await print(JSON.stringify(collectHomeFiles(homedir(), paths)))
    return
  }

  if (mode === 'models') {
    const harness = argument('harness')

    if (harness === 'codex') {
      await print(JSON.stringify({ models: await listCodexModels() }))
      return
    }

    if (harness === 'cursor') {
      await print(JSON.stringify({ models: await listCursorModels() }))
      return
    }

    console.error('models: only the codex and cursor harnesses list their models')
    process.exitCode = 2
    return
  }

  if ((mode !== 'turn' && mode !== 'login') || !dir) {
    console.error('usage: shuttle-agent-bridge <turn|login> --dir <dir>')
    process.exitCode = 2
    return
  }

  const { emit, ended } = createEventWriter(dir)
  const controller = new AbortController()

  process.on('SIGTERM', () => controller.abort())
  process.on('SIGINT', () => controller.abort())
  writeFileSync(join(dir, BRIDGE_PID_FILE), String(process.pid))

  const failure = (message: string): BridgeEventBody =>
    mode === 'turn'
      ? { type: 'turn_done', status: 'failed', text: '', error: message }
      : { type: 'login_done', success: false, error: message }

  try {
    const request = JSON.parse(readFileSync(join(dir, BRIDGE_REQUEST_FILE), 'utf8'))

    await (mode === 'turn'
      ? runTurn(request as BridgeTurnRequest, emit, controller.signal)
      : runLogin(
          request as BridgeLoginRequest,
          emit,
          controller.signal,
          createInputReader(dir, controller.signal),
        ))
  } catch (cause) {
    emit(failure(cause instanceof Error ? cause.message : String(cause)))
  }

  if (!ended()) {
    emit(failure('the agent stopped without finishing'))
  }
}

if (import.meta.main) {
  await main()
  process.exit(process.exitCode ?? 0)
}

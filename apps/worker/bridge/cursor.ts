import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

import {
  clipToolOutput,
  type BridgeEmit,
  type BridgeModel,
  type BridgeToolKind,
  type BridgeTurnRequest,
  type BridgeTurnStatus,
} from './protocol.ts'

/**
 * Drives the unmodified Cursor Agent CLI in print mode
 * (`agent -p --force --trust --output-format stream-json --stream-partial-output`).
 * Sign-in is Cursor's own `agent login` with `NO_OPEN_BROWSER=1`: the user opens the printed
 * link and completes auth in the browser. Credentials live under `~/.cursor` and never pass
 * through this program.
 */

export interface CursorOptions {
  /** The Cursor Agent binary. Tests point this at a fake. */
  readonly bin?: string
}

function cursorBin(options: CursorOptions): string {
  return options.bin ?? (process.env.SHUTTLE_CURSOR_BIN?.trim() || 'agent')
}

function cursorEnv(): NodeJS.ProcessEnv {
  return { ...process.env, NO_OPEN_BROWSER: '1' }
}

/**
 * Seconds Cursor waits, once it has finished, for shells it left running in the background.
 * Without a limit print mode never exits while a dev server it started is up, so the turn never
 * ends and every message sent after it waits forever.
 */
export const CURSOR_BACKGROUND_SHELL_TIMEOUT_SECONDS = 5

/**
 * Cursor's print mode has no system prompt of its own, so standing instructions open the first
 * message of a conversation. A resumed conversation already has them.
 */
function cursorPrompt(request: BridgeTurnRequest, resume: string | undefined): string {
  if (resume || !request.instructions) {
    return request.prompt
  }

  return `<shuttle_instructions>\n${request.instructions}\n</shuttle_instructions>\n\n${request.prompt}`
}

interface ContentBlock {
  readonly type?: string
  readonly text?: string
}

interface ToolCallBody {
  readonly readToolCall?: {
    readonly args?: { readonly path?: string }
    readonly result?: {
      readonly success?: { readonly totalLines?: number; readonly content?: string }
      readonly error?: string
    }
  }
  readonly writeToolCall?: {
    readonly args?: { readonly path?: string }
    readonly result?: {
      readonly success?: { readonly linesCreated?: number; readonly path?: string }
      readonly error?: string
    }
  }
  readonly function?: {
    readonly name?: string
    readonly arguments?: string
  }
  readonly shellToolCall?: {
    readonly args?: { readonly command?: string }
    readonly result?: { readonly success?: { readonly output?: string }; readonly error?: string }
  }
}

interface StreamLine {
  readonly type: string
  readonly subtype?: string
  readonly session_id?: string
  readonly model?: string
  readonly timestamp_ms?: number
  readonly model_call_id?: string
  readonly call_id?: string
  readonly is_error?: boolean
  readonly result?: string
  readonly message?: {
    readonly content?: readonly ContentBlock[]
  }
  readonly tool_call?: ToolCallBody
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toolKindFromCall(call: ToolCallBody | undefined): { kind: BridgeToolKind; title: string } {
  if (call?.readToolCall) {
    const path = call.readToolCall.args?.path
    return { kind: 'other', title: path ? `Read ${path}` : 'Read' }
  }

  if (call?.writeToolCall) {
    const path = call.writeToolCall.args?.path
    return { kind: 'file_change', title: path ? `Write ${path}` : 'Write' }
  }

  if (call?.shellToolCall) {
    const command = call.shellToolCall.args?.command
    return { kind: 'command', title: command || 'Shell' }
  }

  const name = call?.function?.name ?? 'tool'

  if (/shell|bash|terminal|command/i.test(name)) {
    return { kind: 'command', title: name }
  }

  if (/write|edit|apply_patch|search_replace/i.test(name)) {
    return { kind: 'file_change', title: name }
  }

  if (/web_search|web_fetch|fetch/i.test(name)) {
    return { kind: 'web_search', title: name }
  }

  if (/^mcp/i.test(name)) {
    return { kind: 'mcp', title: name }
  }

  return { kind: 'other', title: name }
}

function toolOutput(call: ToolCallBody | undefined): {
  status: 'completed' | 'failed'
  output?: string
} {
  if (call?.readToolCall?.result?.error) {
    return { status: 'failed', output: call.readToolCall.result.error }
  }

  if (call?.writeToolCall?.result?.error) {
    return { status: 'failed', output: call.writeToolCall.result.error }
  }

  if (call?.shellToolCall?.result?.error) {
    return { status: 'failed', output: call.shellToolCall.result.error }
  }

  if (call?.readToolCall?.result?.success) {
    const lines = call.readToolCall.result.success.totalLines
    return {
      status: 'completed',
      ...(typeof lines === 'number' ? { output: `${lines} lines` } : {}),
    }
  }

  if (call?.writeToolCall?.result?.success) {
    const lines = call.writeToolCall.result.success.linesCreated
    return {
      status: 'completed',
      ...(typeof lines === 'number' ? { output: `created ${lines} lines` } : {}),
    }
  }

  if (call?.shellToolCall?.result?.success?.output) {
    return {
      status: 'completed',
      output: clipToolOutput(call.shellToolCall.result.success.output),
    }
  }

  return { status: 'completed' }
}

function assistantText(line: StreamLine): string {
  const content = line.message?.content

  if (!Array.isArray(content)) {
    return ''
  }

  return content.map((block) => (typeof block.text === 'string' ? block.text : '')).join('')
}

/** True for character-level streaming deltas; skips buffered flushes that duplicate text. */
function isStreamingDelta(line: StreamLine): boolean {
  return typeof line.timestamp_ms === 'number' && line.model_call_id === undefined
}

interface Attempt {
  readonly status: BridgeTurnStatus
  readonly text: string
  readonly error?: string
  readonly lostSession: boolean
}

function runAttempt(
  request: BridgeTurnRequest,
  resume: string | undefined,
  emit: BridgeEmit,
  signal: AbortSignal,
  options: CursorOptions,
): Promise<Attempt> {
  const args = [
    '-p',
    '--force',
    '--trust',
    '--output-format',
    'stream-json',
    '--stream-partial-output',
    '--background-shell-timeout',
    String(CURSOR_BACKGROUND_SHELL_TIMEOUT_SECONDS),
    ...(resume ? ['--resume', resume] : []),
    ...(request.model ? ['--model', request.model] : []),
    ...(request.cwd ? ['--workspace', request.cwd] : []),
    cursorPrompt(request, resume),
  ]

  return new Promise<Attempt>((resolve) => {
    let child: ChildProcessWithoutNullStreams

    try {
      child = spawn(cursorBin(options), args, {
        cwd: request.cwd,
        env: cursorEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (cause) {
      resolve({ status: 'failed', text: '', error: String(cause), lostSession: false })
      return
    }

    const tools = new Map<string, { kind: BridgeToolKind; title: string }>()
    let finalText = ''
    let failure: string | undefined
    let sawResult = false
    let sawInit = false
    let stderr = ''
    let interrupted = false

    const interrupt = () => {
      interrupted = true
      child.kill('SIGINT')
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
    }

    signal.addEventListener('abort', interrupt, { once: true })

    child.stderr.on('data', (data: Buffer) => {
      stderr = `${stderr}${data.toString()}`.slice(-2_000)
      process.stderr.write(data)
    })

    createInterface({ input: child.stdout }).on('line', (raw) => {
      let line: StreamLine

      try {
        line = JSON.parse(raw)
      } catch {
        return
      }

      switch (line.type) {
        case 'system': {
          if (line.subtype === 'init' && line.session_id) {
            sawInit = true

            emit({
              type: 'thread',
              vendorThreadId: line.session_id,
              ...(line.model ? { model: line.model } : {}),
            })
          }

          if (line.subtype === 'background_shell_timeout') {
            process.stderr.write(`cursor stopped shells still running after its turn: ${raw}\n`)
          }

          break
        }

        case 'assistant': {
          const text = assistantText(line)

          if (!text) {
            break
          }

          if (isStreamingDelta(line)) {
            emit({ type: 'text_delta', delta: text })
          } else if (typeof line.timestamp_ms !== 'number' && !line.model_call_id) {
            // Final flush at end of a message segment (not a streaming delta).
            emit({ type: 'message', text })
          }

          break
        }

        case 'tool_call': {
          const id = line.call_id

          if (!id) {
            break
          }

          if (line.subtype === 'started') {
            const view = toolKindFromCall(line.tool_call)
            tools.set(id, view)
            emit({ type: 'tool_started', id, ...view })
            break
          }

          if (line.subtype === 'completed') {
            const view = tools.get(id) ?? toolKindFromCall(line.tool_call)
            const finished = toolOutput(line.tool_call)

            emit({
              type: 'tool_finished',
              id,
              ...view,
              status: finished.status,
              ...(finished.output ? { output: finished.output } : {}),
            })
          }

          break
        }

        case 'result': {
          sawResult = true
          finalText = line.result ?? ''

          if (line.is_error) {
            failure ??= line.result || 'cursor reported an error'
          }

          break
        }

        default: {
          break
        }
      }
    })

    child.once('error', (cause) => {
      signal.removeEventListener('abort', interrupt)
      resolve({ status: 'failed', text: '', error: cause.message, lostSession: false })
    })

    child.once('close', (code) => {
      signal.removeEventListener('abort', interrupt)

      if (interrupted) {
        resolve({ status: 'interrupted', text: finalText, lostSession: false })
        return
      }

      if (sawResult && !failure) {
        resolve({ status: 'completed', text: finalText, lostSession: false })
        return
      }

      const error = failure ?? (stderr.trim() || `cursor exited with code ${code}`)

      resolve({
        status: 'failed',
        text: failure ? '' : finalText,
        error,
        lostSession:
          Boolean(resume) &&
          !sawInit &&
          /no (conversation|chat|session) found|unknown (chat|session)/i.test(error),
      })
    })

    // Prompt is on argv; close stdin so the CLI does not wait for interactive input.
    child.stdin.end()
  })
}

export async function runCursorTurn(
  request: BridgeTurnRequest,
  emit: BridgeEmit,
  signal: AbortSignal,
  options: CursorOptions = {},
): Promise<void> {
  let attempt = await runAttempt(request, request.vendorThreadId, emit, signal, options)

  // Cursor keeps chats on the container disk. After the container is replaced the old session
  // is gone, so carry on in a new one instead of failing the turn.
  if (attempt.lostSession) {
    attempt = await runAttempt(request, undefined, emit, signal, options)
  }

  emit({
    type: 'turn_done',
    status: attempt.status,
    text: attempt.text,
    ...(attempt.error ? { error: attempt.error } : {}),
  })
}

function runToEnd(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv = cursorEnv(),
): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    child.once('error', () => resolve({ stdout, code: null }))
    child.once('close', (code) => resolve({ stdout, code }))
  })
}

/** Whether the Cursor Agent CLI reports that it is signed in. */
export async function cursorSignedIn(options: CursorOptions = {}): Promise<boolean> {
  const status = await runToEnd(cursorBin(options), ['status', '--format', 'json'])

  try {
    const parsed = JSON.parse(status.stdout) as Record<string, unknown>
    const userInfo = isRecord(parsed.userInfo) ? parsed.userInfo : undefined

    // Current CLI: `{ "status": "authenticated", "isAuthenticated": true, "userInfo": { ... } }`.
    if (
      parsed.isAuthenticated === true ||
      parsed.authenticated === true ||
      parsed.loggedIn === true ||
      parsed.status === 'authenticated'
    ) {
      return true
    }

    if (
      parsed.isAuthenticated === false ||
      parsed.authenticated === false ||
      parsed.loggedIn === false ||
      parsed.status === 'unauthenticated'
    ) {
      return false
    }

    return (
      typeof parsed.email === 'string' ||
      typeof parsed.userId === 'string' ||
      typeof userInfo?.email === 'string' ||
      typeof userInfo?.userId === 'string' ||
      typeof userInfo?.userId === 'number'
    )
  } catch {
    return /logged in as|isAuthenticated|status.: .authenticated/i.test(status.stdout)
  }
}

const SIGN_IN_URL = /https:\/\/\S+/

/**
 * Signs in with Cursor's own `agent login`. With `NO_OPEN_BROWSER=1` the CLI prints a link; the
 * user completes auth in a browser and the CLI stores credentials under `~/.config/cursor`.
 */
export async function runCursorLogin(
  emit: BridgeEmit,
  signal: AbortSignal,
  options: CursorOptions = {},
): Promise<void> {
  let child: ChildProcessWithoutNullStreams
  let spawnError: string | undefined

  try {
    child = spawn(cursorBin(options), ['login'], {
      env: cursorEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (cause) {
    emit({
      type: 'login_done',
      success: false,
      error: `could not start the Cursor CLI (${cursorBin(options)}): ${String(cause)}`,
    })

    return
  }

  const closed = new Promise<number | null>((resolve) => {
    child.once('error', (cause) => {
      spawnError = cause.message
      resolve(null)
    })

    child.once('close', (code) => resolve(code))
  })

  const cancel = () => child.kill('SIGTERM')

  signal.addEventListener('abort', cancel, { once: true })

  let output = ''
  let prompted = false

  const onOutput = (data: Buffer) => {
    output = `${output}${data.toString()}`.slice(-8_000)

    const url = prompted ? null : SIGN_IN_URL.exec(output)?.[0]

    if (!url) {
      return
    }

    prompted = true
    emit({ type: 'login_prompt', url, code: '', needsCode: false })
  }

  child.stdout.on('data', onOutput)
  child.stderr.on('data', onOutput)
  child.stdin.end()

  try {
    const code = await closed

    if (signal.aborted) {
      emit({ type: 'login_done', success: false, error: 'sign-in was cancelled' })
      return
    }

    if (spawnError) {
      emit({
        type: 'login_done',
        success: false,
        error: `could not start the Cursor CLI (${cursorBin(options)}): ${spawnError}`,
      })

      return
    }

    if (await cursorSignedIn(options)) {
      emit({ type: 'login_done', success: true })
      return
    }

    // Login can report success in its own words even when `status` is briefly unavailable.
    if (code === 0 && /authentication tokens stored securely|logged in as/i.test(output)) {
      emit({ type: 'login_done', success: true })
      return
    }

    const lastLine = output.trim().split('\n').at(-1) ?? ''

    emit({
      type: 'login_done',
      success: false,
      error: prompted
        ? `Cursor did not accept the sign-in (exit code ${code}). ${lastLine}`.trim()
        : `Cursor did not offer a sign-in link (exit code ${code}). ${lastLine}`.trim(),
    })
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

/** The models Cursor offers for this account. */
export async function listCursorModels(options: CursorOptions = {}): Promise<BridgeModel[]> {
  const listed = await runToEnd(cursorBin(options), ['models', '--format', 'json'])

  if (listed.code === 0) {
    const fromJson = parseModelsJson(listed.stdout)

    if (fromJson.length > 0) {
      return fromJson
    }
  }

  const fallback = await runToEnd(cursorBin(options), ['--list-models'])

  return parseModelsText(fallback.stdout)
}

function parseModelsJson(stdout: string): BridgeModel[] {
  try {
    const parsed = JSON.parse(stdout) as unknown

    const entries = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.models)
        ? parsed.models
        : []

    return entries.flatMap((entry): BridgeModel[] => {
      if (typeof entry === 'string' && entry.trim()) {
        return [{ id: entry.trim(), label: entry.trim(), description: '', efforts: [] }]
      }

      if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id.trim()) {
        return []
      }

      const id = entry.id.trim()

      const label =
        typeof entry.label === 'string' && entry.label.trim()
          ? entry.label.trim()
          : typeof entry.name === 'string' && entry.name.trim()
            ? entry.name.trim()
            : id

      return [
        {
          id,
          label,
          description: typeof entry.description === 'string' ? entry.description : '',
          efforts: [],
          ...(entry.isDefault === true || entry.default === true ? { isDefault: true } : {}),
        },
      ]
    })
  } catch {
    return []
  }
}

function parseModelsText(stdout: string): BridgeModel[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !/^models?:$/i.test(line))
    .flatMap((line): BridgeModel[] => {
      // Lines look like `composer-2.5` or `composer-2.5 - Composer 2.5`.
      const match = /^([A-Za-z0-9][A-Za-z0-9._:/-]*)(?:\s*[-–—:]\s*(.+))?$/.exec(line)

      if (!match?.[1]) {
        return []
      }

      return [
        {
          id: match[1],
          label: match[2]?.trim() || match[1],
          description: '',
          efforts: [],
        },
      ]
    })
}

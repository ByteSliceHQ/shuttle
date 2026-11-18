import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

import {
  booleanField,
  decodeEach,
  field,
  isJsonArray,
  isJsonObject,
  isNumber,
  isString,
  nonEmpty,
  numberField,
  objectField,
  parseJson,
  stringField,
  type JsonObject,
  type JsonValue,
} from './json.ts'
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
  /** Shuttle's MCP server for this turn, when the agent gets Shuttle's tools. */
  readonly mcp?: { readonly command: string; readonly args: readonly string[] }
  /** Where Cursor's user config lives. Tests point this at a temporary directory. */
  readonly home?: string
}

/** Tells Shuttle's MCP server which turn it serves, when the agent cannot pass it arguments. */
export const SHUTTLE_RUN_DIR_ENV = 'SHUTTLE_AGENT_RUN_DIR'

/**
 * Cursor reads MCP servers only from its config files, so Shuttle's goes into the user config
 * beside any others. Several sessions can share a sandbox, so the entry names no turn: the
 * server learns its turn from the environment Cursor passes down. Returns false when it could
 * not be written, and the turn runs without Shuttle's tools.
 */
export function installCursorMcp(
  home: string,
  mcp: { readonly command: string; readonly args: readonly string[] },
): boolean {
  const path = join(home, '.cursor', 'mcp.json')
  // The run directory is passed down in the environment instead.
  const args = mcp.args.filter((arg, index, all) => arg !== '--dir' && all[index - 1] !== '--dir')

  try {
    const parsed = existsSync(path) ? parseJson(readFileSync(path, 'utf8')) : {}

    // A config that is not JSON is left alone: the turn runs without Shuttle's tools.
    if (parsed === undefined) {
      return false
    }

    const existing: JsonObject = isJsonObject(parsed) ? parsed : {}

    const next = {
      ...existing,
      mcpServers: {
        ...objectField(existing, 'mcpServers'),
        shuttle: { command: mcp.command, args },
      },
    }

    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`)
    return true
  } catch {
    return false
  }
}

/** The run directory from Shuttle's MCP arguments. */
function mcpRunDir(mcp: CursorOptions['mcp']): string | undefined {
  const index = mcp?.args.indexOf('--dir') ?? -1

  return index >= 0 ? mcp?.args[index + 1] : undefined
}

function cursorBin(options: CursorOptions): string {
  return options.bin ?? (process.env.SHUTTLE_CURSOR_BIN?.trim() || 'agent')
}

function cursorEnv(runDir?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_OPEN_BROWSER: '1' }

  if (runDir) {
    env[SHUTTLE_RUN_DIR_ENV] = runDir
  }

  return env
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

interface ToolResult<Success> {
  readonly success?: Success
  readonly error?: string
}

interface ToolCallBody {
  readonly readToolCall?: {
    readonly args?: { readonly path?: string }
    readonly result?: ToolResult<{ readonly totalLines?: number; readonly content?: string }>
  }
  readonly writeToolCall?: {
    readonly args?: { readonly path?: string }
    readonly result?: ToolResult<{ readonly linesCreated?: number; readonly path?: string }>
  }
  readonly function?: {
    readonly name?: string
    readonly arguments?: string
  }
  readonly shellToolCall?: {
    readonly args?: { readonly command?: string }
    readonly result?: ToolResult<{ readonly output?: string }>
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
    readonly content?: ContentBlock[]
  }
  readonly tool_call?: ToolCallBody
}

function decodeBlock(value: JsonValue): ContentBlock | undefined {
  return isJsonObject(value)
    ? { type: stringField(value, 'type'), text: stringField(value, 'text') }
    : undefined
}

interface DecodedCall<Args, Success> {
  readonly args?: Args
  readonly result?: ToolResult<Success>
}

/** A call of a tool whose arguments are read by `readArgs` and whose success by `readSuccess`. */
function decodeCall<Args, Success>(
  value: JsonValue | undefined,
  readArgs: (args: JsonObject) => Args,
  readSuccess: (success: JsonObject) => Success,
): DecodedCall<Args, Success> | undefined {
  if (!isJsonObject(value)) {
    return undefined
  }

  const args = objectField(value, 'args')
  const result = objectField(value, 'result')
  const success = result === undefined ? undefined : objectField(result, 'success')

  return {
    args: args === undefined ? undefined : readArgs(args),
    result:
      result === undefined
        ? undefined
        : {
            success: success === undefined ? undefined : readSuccess(success),
            error: stringField(result, 'error'),
          },
  }
}

function decodeToolCall(value: JsonValue | undefined): ToolCallBody | undefined {
  if (!isJsonObject(value)) {
    return undefined
  }

  const fn = objectField(value, 'function')

  return {
    readToolCall: decodeCall(
      field(value, 'readToolCall'),
      (args) => ({ path: stringField(args, 'path') }),
      (success) => ({
        totalLines: numberField(success, 'totalLines'),
        content: stringField(success, 'content'),
      }),
    ),
    writeToolCall: decodeCall(
      field(value, 'writeToolCall'),
      (args) => ({ path: stringField(args, 'path') }),
      (success) => ({
        linesCreated: numberField(success, 'linesCreated'),
        path: stringField(success, 'path'),
      }),
    ),
    function:
      fn === undefined
        ? undefined
        : { name: stringField(fn, 'name'), arguments: stringField(fn, 'arguments') },
    shellToolCall: decodeCall(
      field(value, 'shellToolCall'),
      (args) => ({ command: stringField(args, 'command') }),
      (success) => ({ output: stringField(success, 'output') }),
    ),
  }
}

/** One line of Cursor's stream, or undefined when the line is not an object. */
function decodeStreamLine(value: JsonValue | undefined): StreamLine | undefined {
  if (!isJsonObject(value)) {
    return undefined
  }

  const message = objectField(value, 'message')

  return {
    type: stringField(value, 'type') ?? '',
    subtype: stringField(value, 'subtype'),
    session_id: stringField(value, 'session_id'),
    model: stringField(value, 'model'),
    timestamp_ms: numberField(value, 'timestamp_ms'),
    model_call_id: stringField(value, 'model_call_id'),
    call_id: stringField(value, 'call_id'),
    is_error: booleanField(value, 'is_error'),
    result: stringField(value, 'result'),
    message:
      message === undefined
        ? undefined
        : { content: decodeEach(field(message, 'content'), decodeBlock) },
    tool_call: decodeToolCall(field(value, 'tool_call')),
  }
}

interface ToolView {
  readonly kind: BridgeToolKind
  readonly title: string
}

interface ToolOutcome {
  readonly status: 'completed' | 'failed'
  readonly output?: string
}

function toolKindFromCall(call: ToolCallBody | undefined): ToolView {
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

function toolOutput(call: ToolCallBody | undefined): ToolOutcome {
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

    return { status: 'completed', output: lines === undefined ? undefined : `${lines} lines` }
  }

  if (call?.writeToolCall?.result?.success) {
    const lines = call.writeToolCall.result.success.linesCreated

    return {
      status: 'completed',
      output: lines === undefined ? undefined : `created ${lines} lines`,
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
  return (line.message?.content ?? []).map((block) => block.text ?? '').join('')
}

/** True for character-level streaming deltas; skips buffered flushes that duplicate text. */
function isStreamingDelta(line: StreamLine): boolean {
  return line.timestamp_ms !== undefined && line.model_call_id === undefined
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
  const runDir = mcpRunDir(options.mcp)

  const withMcp = Boolean(
    options.mcp && runDir && installCursorMcp(options.home ?? homedir(), options.mcp),
  )

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
    ...(withMcp ? ['--approve-mcps'] : []),
    cursorPrompt(request, resume),
  ]

  return new Promise<Attempt>((resolve) => {
    let child: ChildProcessWithoutNullStreams

    try {
      child = spawn(cursorBin(options), args, {
        cwd: request.cwd,
        env: cursorEnv(withMcp ? runDir : undefined),
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (cause) {
      resolve({ status: 'failed', text: '', error: String(cause), lostSession: false })
      return
    }

    const tools = new Map<string, ToolView>()
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
      const line = decodeStreamLine(parseJson(raw))

      if (line === undefined) {
        return
      }

      switch (line.type) {
        case 'system': {
          if (line.subtype === 'init' && line.session_id) {
            sawInit = true

            emit({
              type: 'thread',
              vendorThreadId: line.session_id,
              model: nonEmpty(line.model),
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
          } else if (line.timestamp_ms === undefined && !line.model_call_id) {
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
              output: nonEmpty(finished.output),
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
    error: nonEmpty(attempt.error),
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

  const parsed = parseJson(status.stdout)

  if (parsed === undefined) {
    return /logged in as|isAuthenticated|status.: .authenticated/i.test(status.stdout)
  }

  if (!isJsonObject(parsed)) {
    return false
  }

  const userInfo: JsonObject = objectField(parsed, 'userInfo') ?? {}

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
    isString(parsed.email) ||
    isString(parsed.userId) ||
    isString(userInfo.email) ||
    isString(userInfo.userId) ||
    isNumber(userInfo.userId)
  )
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
  const parsed = parseJson(stdout)

  const entries = isJsonArray(parsed)
    ? parsed
    : isJsonObject(parsed) && isJsonArray(parsed.models)
      ? parsed.models
      : []

  return entries.flatMap((entry): BridgeModel[] => {
    if (isString(entry) && entry.trim()) {
      return [{ id: entry.trim(), label: entry.trim(), description: '', efforts: [] }]
    }

    if (!isJsonObject(entry) || !isString(entry.id) || !entry.id.trim()) {
      return []
    }

    const id = entry.id.trim()

    const label =
      isString(entry.label) && entry.label.trim()
        ? entry.label.trim()
        : isString(entry.name) && entry.name.trim()
          ? entry.name.trim()
          : id

    return [
      {
        id,
        label,
        description: isString(entry.description) ? entry.description : '',
        efforts: [],
        isDefault: entry.isDefault === true || entry.default === true ? true : undefined,
      },
    ]
  })
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

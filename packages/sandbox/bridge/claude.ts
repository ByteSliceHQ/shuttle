import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

import {
  booleanField,
  decodeEach,
  field,
  isJsonArray,
  isJsonObject,
  isString,
  nonEmpty,
  numberField,
  objectField,
  parseJson,
  stringField,
  type JsonObject,
  type JsonValue,
} from './json'
import {
  clipToolOutput,
  type BridgeEmit,
  type BridgeReadInput,
  type BridgeToolKind,
  type BridgeTurnRequest,
  type BridgeTurnStatus,
} from './protocol'

/**
 * Drives the unmodified Claude Code CLI in print mode (`claude -p --output-format stream-json`).
 * Sign-in is Claude Code's own `claude auth login`: the user opens its link and pastes the code
 * it asks for. Credentials live in `~/.claude` and never pass through this program.
 */

export interface ClaudeOptions {
  /** The Claude Code binary. Tests point this at a fake. */
  readonly bin?: string
  /** Shuttle's MCP server for this turn, when the agent gets Shuttle's tools. */
  readonly mcp?: { readonly command: string; readonly args: readonly string[] }
}

/** Gives Claude Code Shuttle's MCP server for one turn, beside any the user configured. */
export function claudeMcpArgs(mcp: ClaudeOptions['mcp']): string[] {
  return mcp
    ? [
        '--mcp-config',
        JSON.stringify({
          mcpServers: { shuttle: { type: 'stdio', command: mcp.command, args: [...mcp.args] } },
        }),
      ]
    : []
}

function claudeBin(options: ClaudeOptions): string {
  return options.bin ?? (process.env.SHUTTLE_CLAUDE_BIN?.trim() || 'claude')
}

/**
 * The container runs agents as root, and the container is the sandbox. Claude Code only allows
 * unattended permissions as root when it is told it is inside one.
 */
function claudeEnv(): NodeJS.ProcessEnv {
  return { ...process.env, IS_SANDBOX: '1' }
}

interface TextPart {
  readonly text?: string
}

interface ContentBlock {
  readonly type: string
  readonly text?: string
  readonly thinking?: string
  readonly id?: string
  readonly name?: string
  readonly input?: JsonObject
  readonly tool_use_id?: string
  readonly content?: string | TextPart[]
  readonly is_error?: boolean
}

interface StreamLine {
  readonly type: string
  readonly subtype?: string
  readonly session_id?: string
  readonly model?: string
  readonly parent_tool_use_id?: string
  readonly event?: {
    readonly type?: string
    readonly delta?: { readonly type?: string; readonly text?: string; readonly thinking?: string }
  }
  readonly message?: {
    readonly content?: ContentBlock[] | string
    readonly usage?: {
      readonly input_tokens?: number
      readonly output_tokens?: number
      readonly cache_creation_input_tokens?: number
      readonly cache_read_input_tokens?: number
    }
  }
  readonly is_error?: boolean
  readonly result?: string
  readonly error?: string
}

function decodeTextPart(value: JsonValue): TextPart | undefined {
  return isJsonObject(value) ? { text: stringField(value, 'text') } : undefined
}

function decodeBlockContent(value: JsonValue | undefined): string | TextPart[] | undefined {
  if (isString(value)) {
    return value
  }

  return isJsonArray(value) ? decodeEach(value, decodeTextPart) : undefined
}

function decodeBlock(value: JsonValue): ContentBlock | undefined {
  if (!isJsonObject(value)) {
    return undefined
  }

  return {
    type: stringField(value, 'type') ?? '',
    text: stringField(value, 'text'),
    thinking: stringField(value, 'thinking'),
    id: stringField(value, 'id'),
    name: stringField(value, 'name'),
    input: objectField(value, 'input'),
    tool_use_id: stringField(value, 'tool_use_id'),
    content: decodeBlockContent(field(value, 'content')),
    is_error: booleanField(value, 'is_error'),
  }
}

function decodeMessageContent(value: JsonValue | undefined): ContentBlock[] | string | undefined {
  if (isString(value)) {
    return value
  }

  return isJsonArray(value) ? decodeEach(value, decodeBlock) : undefined
}

function decodeMessage(value: JsonValue | undefined): StreamLine['message'] {
  if (!isJsonObject(value)) {
    return undefined
  }

  const usage = objectField(value, 'usage')

  return {
    content: decodeMessageContent(field(value, 'content')),
    usage:
      usage === undefined
        ? undefined
        : {
            input_tokens: numberField(usage, 'input_tokens'),
            output_tokens: numberField(usage, 'output_tokens'),
            cache_creation_input_tokens: numberField(usage, 'cache_creation_input_tokens'),
            cache_read_input_tokens: numberField(usage, 'cache_read_input_tokens'),
          },
  }
}

function decodeEvent(value: JsonValue | undefined): StreamLine['event'] {
  if (!isJsonObject(value)) {
    return undefined
  }

  const delta = objectField(value, 'delta')

  return {
    type: stringField(value, 'type'),
    delta:
      delta === undefined
        ? undefined
        : {
            type: stringField(delta, 'type'),
            text: stringField(delta, 'text'),
            thinking: stringField(delta, 'thinking'),
          },
  }
}

/** One line of Claude Code's stream, or undefined when the line is not an object. */
function decodeStreamLine(value: JsonValue | undefined): StreamLine | undefined {
  if (!isJsonObject(value)) {
    return undefined
  }

  return {
    type: stringField(value, 'type') ?? '',
    subtype: stringField(value, 'subtype'),
    session_id: stringField(value, 'session_id'),
    model: stringField(value, 'model'),
    parent_tool_use_id: stringField(value, 'parent_tool_use_id'),
    event: decodeEvent(field(value, 'event')),
    message: decodeMessage(field(value, 'message')),
    is_error: booleanField(value, 'is_error'),
    result: stringField(value, 'result'),
    error: stringField(value, 'error'),
  }
}

function toolKind(name: string): BridgeToolKind {
  if (name === 'Bash') {
    return 'command'
  }

  if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit') {
    return 'file_change'
  }

  if (name === 'WebSearch' || name === 'WebFetch') {
    return 'web_search'
  }

  return name.startsWith('mcp__') ? 'mcp' : 'other'
}

function toolTitle(name: string, input: JsonObject = {}): string {
  const detail = [
    input.command,
    input.file_path,
    input.pattern,
    input.query,
    input.url,
    input.description,
  ].find((value): value is string => isString(value) && value.length > 0)

  if ((name === 'Bash' || name === 'WebSearch' || name === 'WebFetch') && detail) {
    return detail
  }

  return detail ? `${name} ${detail}` : name
}

function resultText(content: string | TextPart[] | undefined): string {
  if (Array.isArray(content)) {
    return content.map((block) => block.text ?? '').join('')
  }

  return content ?? ''
}

interface Attempt {
  readonly status: BridgeTurnStatus
  readonly text: string
  readonly error?: string
  /** True when Claude Code produced nothing because the session to resume no longer exists. */
  readonly lostSession: boolean
}

function runAttempt(
  request: BridgeTurnRequest,
  resume: string | undefined,
  emit: BridgeEmit,
  signal: AbortSignal,
  options: ClaudeOptions,
): Promise<Attempt> {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode',
    'bypassPermissions',
    ...(resume ? ['--resume', resume] : []),
    ...(request.model ? ['--model', request.model] : []),
    ...(request.effort ? ['--effort', request.effort] : []),
    ...(request.instructions ? ['--append-system-prompt', request.instructions] : []),
    ...claudeMcpArgs(options.mcp),
  ]

  return new Promise<Attempt>((resolve) => {
    let child: ChildProcessWithoutNullStreams

    try {
      child = spawn(claudeBin(options), args, {
        cwd: request.cwd,
        env: claudeEnv(),
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
      const line = decodeStreamLine(parseJson(raw))

      if (line === undefined) {
        return
      }

      const topLevel = line.parent_tool_use_id === undefined || line.parent_tool_use_id === ''

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

          break
        }

        case 'stream_event': {
          const delta = line.event?.delta

          if (!topLevel || line.event?.type !== 'content_block_delta' || !delta) {
            break
          }

          if (delta.type === 'text_delta' && delta.text) {
            emit({ type: 'text_delta', delta: delta.text })
          }

          if (delta.type === 'thinking_delta' && delta.thinking) {
            emit({ type: 'thought_delta', delta: delta.thinking })
          }

          break
        }

        case 'assistant': {
          const content = line.message?.content

          if (line.error && (content === undefined || Array.isArray(content))) {
            failure = resultText(content) || line.error
          }

          if (!Array.isArray(content)) {
            break
          }

          for (const block of content) {
            if (block.type === 'thinking' && block.thinking?.trim() && topLevel) {
              emit({ type: 'thought', text: block.thinking.trim() })
            }

            if (block.type === 'text' && block.text && topLevel && !line.error) {
              emit({ type: 'message', text: block.text })
            }

            if (block.type === 'tool_use' && block.id && block.name) {
              const view = { kind: toolKind(block.name), title: toolTitle(block.name, block.input) }

              tools.set(block.id, view)
              emit({ type: 'tool_started', id: block.id, ...view })
            }
          }

          const usage = line.message?.usage

          if (usage && topLevel && !line.error) {
            emit({
              type: 'usage',
              input:
                (usage.input_tokens ?? 0) +
                (usage.cache_creation_input_tokens ?? 0) +
                (usage.cache_read_input_tokens ?? 0),
              output: usage.output_tokens ?? 0,
            })
          }

          break
        }

        case 'user': {
          const content = line.message?.content

          if (!Array.isArray(content)) {
            break
          }

          for (const block of content) {
            const view = block.tool_use_id ? tools.get(block.tool_use_id) : undefined

            if (block.type === 'tool_result' && block.tool_use_id && view) {
              const output = resultText(block.content)

              emit({
                type: 'tool_finished',
                id: block.tool_use_id,
                ...view,
                status: block.is_error === true ? 'failed' : 'completed',
                output: output === '' ? undefined : clipToolOutput(output),
              })
            }
          }

          break
        }

        case 'result': {
          sawResult = true
          finalText = line.result ?? ''

          if (line.is_error) {
            failure ??= line.result || 'claude reported an error'
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

      const error = failure ?? (stderr.trim() || `claude exited with code ${code}`)

      resolve({
        status: 'failed',
        text: failure ? '' : finalText,
        error,
        lostSession: Boolean(resume) && !sawInit && /no conversation found/i.test(error),
      })
    })

    child.stdin.end(request.prompt)
  })
}

export async function runClaudeTurn(
  request: BridgeTurnRequest,
  emit: BridgeEmit,
  signal: AbortSignal,
  options: ClaudeOptions = {},
): Promise<void> {
  let attempt = await runAttempt(request, request.vendorThreadId, emit, signal, options)

  // Claude Code keeps conversations on the container disk. After the container is replaced the
  // old session is gone, so carry on in a new one instead of failing the turn.
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

function runToEnd(bin: string, args: string[]): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env: claudeEnv(), stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    child.once('error', () => resolve({ stdout, code: null }))
    child.once('close', (code) => resolve({ stdout, code }))
  })
}

/** Whether Claude Code reports that it is signed in. */
export async function claudeSignedIn(options: ClaudeOptions = {}): Promise<boolean> {
  const status = await runToEnd(claudeBin(options), ['auth', 'status'])

  const parsed = parseJson(status.stdout)

  return isJsonObject(parsed) && booleanField(parsed, 'loggedIn') === true
}

const SIGN_IN_URL = /https:\/\/\S+/

/**
 * Signs in to Claude Code with its own `claude auth login`. Claude Code prints a link, the user
 * approves there and gets a code, and Claude Code reads that code on stdin.
 */
export async function runClaudeLogin(
  emit: BridgeEmit,
  signal: AbortSignal,
  readInput: BridgeReadInput,
  options: ClaudeOptions = {},
): Promise<void> {
  const child = spawn(claudeBin(options), ['auth', 'login'], {
    env: claudeEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const closed = new Promise<number | null>((resolve) => {
    child.once('error', () => resolve(null))
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
    emit({ type: 'login_prompt', url, code: '', needsCode: true })

    readInput().then(
      (code) => child.stdin.write(`${code.trim()}\n`),
      () => {},
    )
  }

  child.stdout.on('data', onOutput)
  child.stderr.on('data', onOutput)

  try {
    const code = await closed

    if (signal.aborted) {
      emit({ type: 'login_done', success: false, error: 'sign-in was cancelled' })
      return
    }

    if (await claudeSignedIn(options)) {
      emit({ type: 'login_done', success: true })
      return
    }

    const lastLine = output.trim().split('\n').at(-1) ?? ''

    emit({
      type: 'login_done',
      success: false,
      error: prompted
        ? `Claude Code did not accept the sign-in (exit code ${code}). ${lastLine}`.trim()
        : `Claude Code did not offer a sign-in link (exit code ${code}). ${lastLine}`.trim(),
    })
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

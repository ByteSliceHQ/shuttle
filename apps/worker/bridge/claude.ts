import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

import {
  clipToolOutput,
  type BridgeEmit,
  type BridgeReadInput,
  type BridgeToolKind,
  type BridgeTurnRequest,
  type BridgeTurnStatus,
} from './protocol.ts'

/**
 * Drives the unmodified Claude Code CLI in print mode (`claude -p --output-format stream-json`).
 * Sign-in is Claude Code's own `claude auth login`: the user opens its link and pastes the code
 * it asks for. Credentials live in `~/.claude` and never pass through this program.
 */

export interface ClaudeOptions {
  /** The Claude Code binary. Tests point this at a fake. */
  readonly bin?: string
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

interface ContentBlock {
  readonly type: string
  readonly text?: string
  readonly thinking?: string
  readonly id?: string
  readonly name?: string
  readonly input?: Record<string, unknown>
  readonly tool_use_id?: string
  readonly content?: unknown
  readonly is_error?: boolean
}

interface StreamLine {
  readonly type: string
  readonly subtype?: string
  readonly session_id?: string
  readonly model?: string
  readonly parent_tool_use_id?: string | null
  readonly event?: {
    readonly type?: string
    readonly delta?: { readonly type?: string; readonly text?: string; readonly thinking?: string }
  }
  readonly message?: {
    readonly content?: readonly ContentBlock[] | string
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

function toolTitle(name: string, input: Record<string, unknown> = {}): string {
  const detail = [
    input.command,
    input.file_path,
    input.pattern,
    input.query,
    input.url,
    input.description,
  ].find((value): value is string => typeof value === 'string' && value.length > 0)

  if ((name === 'Bash' || name === 'WebSearch' || name === 'WebFetch') && detail) {
    return detail
  }

  return detail ? `${name} ${detail}` : name
}

function resultText(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    return ''
  }

  return content
    .map((block: ContentBlock) => (typeof block.text === 'string' ? block.text : ''))
    .join('')
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
      let line: StreamLine

      try {
        line = JSON.parse(raw)
      } catch {
        return
      }

      const topLevel = !line.parent_tool_use_id

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

          if (line.error && typeof content !== 'string') {
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
                status: block.is_error ? 'failed' : 'completed',
                ...(output ? { output: clipToolOutput(output) } : {}),
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
    ...(attempt.error ? { error: attempt.error } : {}),
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

  try {
    return (JSON.parse(status.stdout) as { loggedIn?: boolean }).loggedIn === true
  } catch {
    return false
  }
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

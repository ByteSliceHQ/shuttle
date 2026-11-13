import { spawn } from 'node:child_process'

import { JsonRpcPeer } from './jsonrpc.ts'
import {
  clipToolOutput,
  type BridgeEmit,
  type BridgeToolKind,
  type BridgeToolStatus,
  type BridgeTurnRequest,
  type BridgeTurnStatus,
} from './protocol.ts'

/**
 * Drives the unmodified Codex CLI through `codex app-server` (JSON-RPC over stdio). Sign-in is
 * Codex's own: credentials live in `~/.codex` and never pass through this program.
 */

export interface CodexOptions {
  /** The app server command. Tests point this at a fake. */
  readonly command?: readonly string[]
  /** How long to wait for Codex to wind down after an interrupt. */
  readonly interruptGraceMs?: number
}

/** `SHUTTLE_CODEX_BIN` points at a Codex binary that is not on PATH. */
function defaultCommand(): readonly string[] {
  return [process.env.SHUTTLE_CODEX_BIN?.trim() || 'codex', 'app-server']
}

const CLIENT_INFO = { name: 'shuttle', title: 'Shuttle', version: '0.0.1' }

interface CodexItem {
  readonly type: string
  readonly id: string
  readonly text?: string
  readonly command?: string
  readonly status?: string
  readonly aggregatedOutput?: string | null
  readonly exitCode?: number | null
  readonly changes?: ReadonlyArray<{ readonly path: string }>
  readonly server?: string
  readonly tool?: string
  readonly query?: string
  readonly summary?: readonly string[]
  readonly content?: readonly string[]
}

/** Codex runs commands as `/bin/bash -lc '<script>'`. Show the script, not the wrapper. */
export function unwrapShell(command: string): string {
  const match = /^(?:\/usr)?\/bin\/(?:ba|z)?sh -l?c (['"])([\s\S]*)\1$/.exec(command.trim())

  if (!match?.[2]) {
    return command
  }

  return match[1] === '"' ? match[2].replaceAll(/\\(["\\$`])/g, '$1') : match[2]
}

interface ToolView {
  readonly kind: BridgeToolKind
  readonly title: string
}

function toolView(item: CodexItem): ToolView | null {
  switch (item.type) {
    case 'commandExecution': {
      return { kind: 'command', title: unwrapShell(item.command ?? 'command') }
    }

    case 'fileChange': {
      const paths = (item.changes ?? []).map((change) => change.path)
      return { kind: 'file_change', title: paths.join(', ') || 'file change' }
    }

    case 'mcpToolCall': {
      return { kind: 'mcp', title: `${item.server ?? 'mcp'}.${item.tool ?? 'tool'}` }
    }

    case 'webSearch': {
      return { kind: 'web_search', title: item.query || 'web search' }
    }

    default: {
      return null
    }
  }
}

function toolStatus(status: string | undefined): BridgeToolStatus {
  return status === 'failed' || status === 'declined' ? status : 'completed'
}

function connect(
  options: CodexOptions,
  onNotification: (method: string, params: unknown) => void,
): JsonRpcPeer {
  const [bin, ...args] = options.command ?? defaultCommand()

  if (!bin) {
    throw new Error('codex command is empty')
  }

  const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] })

  // Codex logs to stderr. It goes to the bridge log, never to the events file.
  child.stderr.on('data', (data: Buffer) => process.stderr.write(data))

  return new JsonRpcPeer(child, {
    onNotification,
    // Turns run with approvals off, so Codex should not ask. If it does, refuse instead of
    // hanging the turn on a question nobody will answer.
    onRequest: (method) => {
      throw new Error(`shuttle does not handle ${method}`)
    },
  })
}

async function handshake(peer: JsonRpcPeer): Promise<void> {
  await peer.request('initialize', { clientInfo: CLIENT_INFO })
  peer.notify('initialized', {})
}

export async function runCodexTurn(
  request: BridgeTurnRequest,
  emit: BridgeEmit,
  signal: AbortSignal,
  options: CodexOptions = {},
): Promise<void> {
  let finalText = ''
  let threadId = request.vendorThreadId
  let turnId: string | undefined

  const { promise: finished, resolve: finish } = Promise.withResolvers<{
    status: BridgeTurnStatus
    error?: string
  }>()

  const peer = connect(options, (method, raw) => {
    const params = (raw ?? {}) as {
      delta?: string
      item?: CodexItem
      tokenUsage?: {
        last?: { inputTokens?: number; outputTokens?: number }
        modelContextWindow?: number | null
      }
      turn?: { status?: string; error?: { message?: string } | null }
      error?: { message?: string }
      willRetry?: boolean
    }

    switch (method) {
      case 'item/agentMessage/delta': {
        if (params.delta) {
          emit({ type: 'text_delta', delta: params.delta })
        }

        break
      }

      case 'item/reasoning/summaryTextDelta':

      case 'item/reasoning/textDelta': {
        if (params.delta) {
          emit({ type: 'thought_delta', delta: params.delta })
        }

        break
      }

      case 'item/started': {
        const view = params.item ? toolView(params.item) : null

        if (view && params.item) {
          emit({ type: 'tool_started', id: params.item.id, ...view })
        }

        break
      }

      case 'item/completed': {
        const item = params.item

        if (!item) {
          break
        }

        if (item.type === 'agentMessage' && item.text) {
          finalText = item.text
          emit({ type: 'message', text: item.text })
          break
        }

        if (item.type === 'reasoning') {
          const text = [...(item.summary ?? []), ...(item.content ?? [])].join('\n\n').trim()

          if (text) {
            emit({ type: 'thought', text })
          }

          break
        }

        const view = toolView(item)

        if (view) {
          emit({
            type: 'tool_finished',
            id: item.id,
            ...view,
            status: toolStatus(item.status),
            ...(item.aggregatedOutput ? { output: clipToolOutput(item.aggregatedOutput) } : {}),
            ...(typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {}),
          })
        }

        break
      }

      case 'thread/tokenUsage/updated': {
        const usage = params.tokenUsage

        if (usage?.last) {
          emit({
            type: 'usage',
            input: usage.last.inputTokens ?? 0,
            output: usage.last.outputTokens ?? 0,
            ...(typeof usage.modelContextWindow === 'number'
              ? { contextWindow: usage.modelContextWindow }
              : {}),
          })
        }

        break
      }

      case 'turn/completed': {
        const status = params.turn?.status

        finish({
          status: status === 'completed' || status === 'interrupted' ? status : 'failed',
          ...(params.turn?.error?.message ? { error: params.turn.error.message } : {}),
        })

        break
      }

      case 'error': {
        if (params.willRetry === false) {
          finish({ status: 'failed', error: params.error?.message ?? 'codex reported an error' })
        }

        break
      }

      default: {
        break
      }
    }
  })

  void peer.exited.then((code) =>
    finish({ status: 'failed', error: `codex exited before the turn finished (code ${code})` }),
  )

  const interrupt = () => {
    if (threadId && turnId) {
      peer.request('turn/interrupt', { threadId, turnId }).catch(() => {})
    }

    // Codex confirms an interrupt with turn/completed. Do not wait on it forever.
    setTimeout(() => finish({ status: 'interrupted' }), options.interruptGraceMs ?? 5_000).unref()
  }

  signal.addEventListener('abort', interrupt, { once: true })

  try {
    await handshake(peer)

    // The container is the sandbox, so Codex runs unrestricted inside it and never asks.
    const session = { cwd: request.cwd, approvalPolicy: 'never', sandbox: 'danger-full-access' }

    const startThread = () =>
      peer.request<{ thread: { id: string }; model?: string }>('thread/start', {
        ...session,
        serviceName: CLIENT_INFO.name,
        ...(request.model ? { model: request.model } : {}),
        ...(request.instructions ? { developerInstructions: request.instructions } : {}),
      })

    // Codex keeps conversations on the container disk. After the container is replaced the old
    // thread is gone, so carry on in a new one instead of failing the turn.
    const opened = threadId
      ? await peer
          .request<{ thread: { id: string }; model?: string }>('thread/resume', {
            ...session,
            threadId,
            excludeTurns: true,
            ...(request.instructions ? { developerInstructions: request.instructions } : {}),
          })
          .catch(startThread)
      : await startThread()

    threadId = opened.thread.id

    emit({
      type: 'thread',
      vendorThreadId: threadId,
      ...(opened.model ? { model: opened.model } : {}),
    })

    const started = await peer.request<{ turn: { id: string } }>('turn/start', {
      threadId,
      input: [{ type: 'text', text: request.prompt, text_elements: [] }],
      // Codex sends no reasoning at all unless a summary is asked for.
      summary: 'auto',
      ...(request.model ? { model: request.model } : {}),
    })

    turnId = started.turn.id

    if (signal.aborted) {
      interrupt()
    }

    const result = await finished

    emit({ type: 'turn_done', status: result.status, text: finalText, ...errorField(result) })
  } catch (cause) {
    emit({
      type: 'turn_done',
      status: 'failed',
      text: finalText,
      error: cause instanceof Error ? cause.message : String(cause),
    })
  } finally {
    signal.removeEventListener('abort', interrupt)
    peer.kill()
  }
}

function errorField(result: { error?: string }): { error?: string } {
  return result.error ? { error: result.error } : {}
}

/** Signs in to Codex with a ChatGPT plan using Codex's own device-code flow. */
export async function runCodexLogin(
  emit: BridgeEmit,
  signal: AbortSignal,
  options: CodexOptions = {},
): Promise<void> {
  let loginId: string | undefined

  const { promise: finished, resolve: finish } = Promise.withResolvers<{
    success: boolean
    error?: string
  }>()

  const peer = connect(options, (method, raw) => {
    if (method !== 'account/login/completed') {
      return
    }

    const params = (raw ?? {}) as { loginId?: string | null; success?: boolean; error?: string }

    if (!loginId || !params.loginId || params.loginId === loginId) {
      finish({ success: params.success === true, ...(params.error ? { error: params.error } : {}) })
    }
  })

  void peer.exited.then((code) =>
    finish({ success: false, error: `codex exited during sign-in (code ${code})` }),
  )

  const cancel = () => {
    if (loginId) {
      peer.request('account/login/cancel', { loginId }).catch(() => {})
    }

    finish({ success: false, error: 'sign-in was cancelled' })
  }

  signal.addEventListener('abort', cancel, { once: true })

  try {
    await handshake(peer)

    const started = await peer.request<{
      loginId: string
      verificationUrl: string
      userCode: string
    }>('account/login/start', { type: 'chatgptDeviceCode' })

    loginId = started.loginId
    emit({ type: 'login_prompt', url: started.verificationUrl, code: started.userCode })

    const result = await finished

    emit({ type: 'login_done', success: result.success, ...errorField(result) })
  } catch (cause) {
    emit({
      type: 'login_done',
      success: false,
      error: cause instanceof Error ? cause.message : String(cause),
    })
  } finally {
    signal.removeEventListener('abort', cancel)
    peer.kill()
  }
}

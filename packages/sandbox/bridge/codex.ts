import { spawn } from 'node:child_process'

import {
  booleanField,
  decodeEach,
  definedFields,
  field,
  isJsonObject,
  isString,
  nonEmpty,
  numberField,
  objectField,
  stringField,
  type JsonObject,
  type JsonValue,
} from './json'
import { JsonRpcPeer } from './jsonrpc'
import {
  clipToolOutput,
  type BridgeEmit,
  type BridgeModel,
  type BridgeToolKind,
  type BridgeToolStatus,
  type BridgeTurnRequest,
  type BridgeTurnStatus,
} from './protocol'

/**
 * Drives the unmodified Codex CLI through `codex app-server` (JSON-RPC over stdio). Sign-in is
 * Codex's own: credentials live in `~/.codex` and never pass through this program.
 */

export interface CodexOptions {
  /** The app server command. Tests point this at a fake. */
  readonly command?: readonly string[]
  /** How long to wait for Codex to wind down after an interrupt. */
  readonly interruptGraceMs?: number
  /** Shuttle's MCP server for this turn, when the agent gets Shuttle's tools. */
  readonly mcp?: { readonly command: string; readonly args: readonly string[] }
}

/**
 * Config overrides that give Codex Shuttle's MCP server for one turn, without touching the
 * user's `config.toml`. Its tools are approved up front: turns run unattended.
 */
export function codexMcpOverrides(mcp: CodexOptions['mcp']): string[] {
  if (!mcp) {
    return []
  }

  // JSON strings and arrays of them are valid TOML.
  return [
    '-c',
    `mcp_servers.shuttle.command=${JSON.stringify(mcp.command)}`,
    '-c',
    `mcp_servers.shuttle.args=${JSON.stringify(mcp.args)}`,
    '-c',
    'mcp_servers.shuttle.default_tools_approval_mode="approve"',
  ]
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
  readonly aggregatedOutput?: string
  readonly exitCode?: number
  readonly changes?: readonly { readonly path: string }[]
  readonly server?: string
  readonly tool?: string
  readonly query?: string
  readonly summary?: readonly string[]
  readonly content?: readonly string[]
}

function decodeString(value: JsonValue): string | undefined {
  return isString(value) ? value : undefined
}

function decodeChange(value: JsonValue): { readonly path: string } | undefined {
  return isJsonObject(value) ? { path: stringField(value, 'path') ?? '' } : undefined
}

function decodeItem(value: JsonValue | undefined): CodexItem | undefined {
  if (!isJsonObject(value)) {
    return undefined
  }

  return {
    type: stringField(value, 'type') ?? '',
    id: stringField(value, 'id') ?? '',
    text: stringField(value, 'text'),
    command: stringField(value, 'command'),
    status: stringField(value, 'status'),
    aggregatedOutput: stringField(value, 'aggregatedOutput'),
    exitCode: numberField(value, 'exitCode'),
    changes: decodeEach(field(value, 'changes'), decodeChange),
    server: stringField(value, 'server'),
    tool: stringField(value, 'tool'),
    query: stringField(value, 'query'),
    summary: decodeEach(field(value, 'summary'), decodeString),
    content: decodeEach(field(value, 'content'), decodeString),
  }
}

/** What a notification from `codex app-server` carries, whichever of these it has. */
interface NotificationParams {
  readonly delta?: string
  readonly item?: CodexItem
  readonly tokenUsage?: {
    readonly last?: { readonly inputTokens?: number; readonly outputTokens?: number }
    readonly modelContextWindow?: number
  }
  readonly turn?: { readonly status?: string; readonly errorMessage?: string }
  readonly errorMessage?: string
  readonly willRetry?: boolean
}

function messageOf(value: JsonValue | undefined): string | undefined {
  return isJsonObject(value) ? stringField(value, 'message') : undefined
}

function decodeTokenUsage(value: JsonValue | undefined): NotificationParams['tokenUsage'] {
  if (!isJsonObject(value)) {
    return undefined
  }

  const last = objectField(value, 'last')

  return {
    last:
      last === undefined
        ? undefined
        : {
            inputTokens: numberField(last, 'inputTokens'),
            outputTokens: numberField(last, 'outputTokens'),
          },
    modelContextWindow: numberField(value, 'modelContextWindow'),
  }
}

function decodeNotification(raw: JsonValue | undefined): NotificationParams {
  if (!isJsonObject(raw)) {
    return {}
  }

  const turn = objectField(raw, 'turn')

  return {
    delta: stringField(raw, 'delta'),
    item: decodeItem(field(raw, 'item')),
    tokenUsage: decodeTokenUsage(field(raw, 'tokenUsage')),
    turn:
      turn === undefined
        ? undefined
        : { status: stringField(turn, 'status'), errorMessage: messageOf(field(turn, 'error')) },
    errorMessage: messageOf(field(raw, 'error')),
    willRetry: booleanField(raw, 'willRetry'),
  }
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
  onNotification: (method: string, params: JsonValue | undefined) => void,
): JsonRpcPeer {
  const [bin, ...base] = options.command ?? defaultCommand()
  const args = [...base, ...codexMcpOverrides(options.mcp)]

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

interface CodexModel {
  readonly id: string
  readonly model?: string
  readonly displayName?: string
  readonly description?: string
  readonly hidden?: boolean
  readonly isDefault?: boolean
  readonly defaultReasoningEffort?: string
  readonly supportedReasoningEfforts: readonly string[]
}

interface CodexModelPage {
  readonly data: readonly CodexModel[]
  readonly nextCursor?: string
}

function decodeEffort(value: JsonValue): string | undefined {
  return isJsonObject(value) ? stringField(value, 'reasoningEffort') : undefined
}

function decodeModel(value: JsonValue): CodexModel | undefined {
  if (!isJsonObject(value)) {
    return undefined
  }

  const id = stringField(value, 'id')

  if (id === undefined) {
    return undefined
  }

  return {
    id,
    model: stringField(value, 'model'),
    displayName: stringField(value, 'displayName'),
    description: stringField(value, 'description'),
    hidden: booleanField(value, 'hidden'),
    isDefault: booleanField(value, 'isDefault'),
    defaultReasoningEffort: stringField(value, 'defaultReasoningEffort'),
    supportedReasoningEfforts: decodeEach(field(value, 'supportedReasoningEfforts'), decodeEffort),
  }
}

function decodeModelPage(value: JsonValue): CodexModelPage {
  if (!isJsonObject(value)) {
    return { data: [] }
  }

  return {
    data: decodeEach(field(value, 'data'), decodeModel),
    nextCursor: stringField(value, 'nextCursor'),
  }
}

/** The thread Codex opened, from the answer to `thread/start` or `thread/resume`. */
interface OpenedThread {
  readonly id: string
  readonly model?: string
}

function decodeOpenedThread(value: JsonValue): OpenedThread {
  const thread = isJsonObject(value) ? objectField(value, 'thread') : undefined
  const id = thread === undefined ? undefined : stringField(thread, 'id')

  if (!isJsonObject(value) || id === undefined) {
    throw new Error('codex did not say which thread it opened')
  }

  return { id, model: stringField(value, 'model') }
}

function decodeStartedTurnId(value: JsonValue): string {
  const turn = isJsonObject(value) ? objectField(value, 'turn') : undefined
  const id = turn === undefined ? undefined : stringField(turn, 'id')

  if (id === undefined) {
    throw new Error('codex did not say which turn it started')
  }

  return id
}

interface DeviceLogin {
  readonly loginId: string
  readonly verificationUrl: string
  readonly userCode: string
}

function decodeDeviceLogin(value: JsonValue): DeviceLogin {
  const login = isJsonObject(value) ? value : undefined
  const loginId = login === undefined ? undefined : stringField(login, 'loginId')
  const verificationUrl = login === undefined ? undefined : stringField(login, 'verificationUrl')
  const userCode = login === undefined ? undefined : stringField(login, 'userCode')

  if (loginId === undefined || verificationUrl === undefined || userCode === undefined) {
    throw new Error('codex did not offer a device code')
  }

  return { loginId, verificationUrl, userCode }
}

/** The models Codex offers in its own picker. Codex answers this without being signed in. */
export async function listCodexModels(options: CodexOptions = {}): Promise<BridgeModel[]> {
  const peer = connect(options, () => {})

  try {
    await handshake(peer)

    const models: BridgeModel[] = []
    let cursor: string | null = null

    // A handful of pages at most. The cap only stops a server that never ends its list.
    for (let page = 0; page < 10; page += 1) {
      const listed = decodeModelPage(await peer.request('model/list', cursor ? { cursor } : {}))

      for (const entry of listed.data) {
        if (entry.hidden) {
          continue
        }

        models.push({
          id: entry.model ?? entry.id,
          label: entry.displayName ?? entry.id,
          description: entry.description ?? '',
          efforts: entry.supportedReasoningEfforts,
          defaultEffort: nonEmpty(entry.defaultReasoningEffort),
          isDefault: entry.isDefault === true ? true : undefined,
        })
      }

      cursor = listed.nextCursor ?? null

      if (!cursor) {
        break
      }
    }

    return models
  } finally {
    peer.kill()
  }
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
    const params = decodeNotification(raw)

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
          const output = nonEmpty(item.aggregatedOutput)

          emit({
            type: 'tool_finished',
            id: item.id,
            ...view,
            status: toolStatus(item.status),
            output: output === undefined ? undefined : clipToolOutput(output),
            exitCode: item.exitCode,
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
            contextWindow: usage.modelContextWindow,
          })
        }

        break
      }

      case 'turn/completed': {
        const status = params.turn?.status

        finish({
          status: status === 'completed' || status === 'interrupted' ? status : 'failed',
          error: nonEmpty(params.turn?.errorMessage),
        })

        break
      }

      case 'error': {
        if (params.willRetry === false) {
          finish({ status: 'failed', error: params.errorMessage ?? 'codex reported an error' })
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
      peer.request(
        'thread/start',
        definedFields({
          ...session,
          serviceName: CLIENT_INFO.name,
          model: nonEmpty(request.model),
          developerInstructions: nonEmpty(request.instructions),
        }),
      )

    // Codex keeps conversations on the container disk. After the container is replaced the old
    // thread is gone, so carry on in a new one instead of failing the turn.
    const opened = decodeOpenedThread(
      threadId
        ? await peer
            .request(
              'thread/resume',
              definedFields({
                ...session,
                threadId,
                excludeTurns: true,
                developerInstructions: nonEmpty(request.instructions),
              }),
            )
            .catch(startThread)
        : await startThread(),
    )

    threadId = opened.id

    // A resumed thread reports the model it started on. The turn runs on the one asked for.
    const model = request.model ?? opened.model

    emit({ type: 'thread', vendorThreadId: threadId, model: nonEmpty(model) })

    const started = await peer.request(
      'turn/start',
      definedFields({
        threadId,
        input: [{ type: 'text', text: request.prompt, text_elements: [] }],
        // Codex sends no reasoning at all unless a summary is asked for.
        summary: 'auto',
        model: nonEmpty(request.model),
        effort: nonEmpty(request.effort),
      }),
    )

    turnId = decodeStartedTurnId(started)

    if (signal.aborted) {
      interrupt()
    }

    const result = await finished

    emit({
      type: 'turn_done',
      status: result.status,
      text: finalText,
      error: nonEmpty(result.error),
    })
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

    const params: JsonObject = isJsonObject(raw) ? raw : {}
    const completedLogin = stringField(params, 'loginId')

    if (!loginId || !completedLogin || completedLogin === loginId) {
      finish({
        success: booleanField(params, 'success') === true,
        error: nonEmpty(stringField(params, 'error')),
      })
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

    const started = decodeDeviceLogin(
      await peer.request('account/login/start', { type: 'chatgptDeviceCode' }),
    )

    loginId = started.loginId
    emit({ type: 'login_prompt', url: started.verificationUrl, code: started.userCode })

    const result = await finished

    emit({ type: 'login_done', success: result.success, error: nonEmpty(result.error) })
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

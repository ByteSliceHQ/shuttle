import type { AgentTurnResult, LlmCompleteArgs } from '@swirls/looms/agent'

import type { BridgeEvent, BridgeToolKind } from '../../bridge/protocol'
import type { ShareResult } from '../assets/sandbox'
import type { CredentialPayload } from '../credentials/store'
import type { SessionSandboxStub } from '../env'
import type { VendorHarnessId } from '../harness'
import { getStepObserver, getThinkingObserver, type VendorStep } from '../llm'
import { SHARE_FILE_TOOL } from '../tools/share-file'
import { vendorHarnessInfo } from './harnesses'
import type { VendorModelChoice } from './models'

/**
 * Runs one agent turn on a vendor coding agent in the sandbox container, in place of a model
 * call. The vendor agent plans and edits with its own tools; this follows its event stream and
 * hands the result back to Looms as an ordinary assistant message.
 */

type SandboxForTurn = Pick<
  SessionSandboxStub,
  'startAgentRun' | 'readAgentEvents' | 'agentRunState' | 'stopAgentRun' | 'collectAgentFiles'
>

type TurnStorage = Pick<DurableObjectStorage, 'get' | 'put'>

export interface VendorTurnDeps {
  readonly harness: VendorHarnessId
  readonly runId: string
  readonly cwd: string
  readonly sandbox: SandboxForTurn
  readonly storage: TurnStorage
  readonly credentials: {
    get(harness: VendorHarnessId): Promise<CredentialPayload | null>
    put(harness: VendorHarnessId, payload: CredentialPayload): Promise<void>
  }
  /**
   * Set when the agent is a member of a hybrid team, with the Looms thread running this task.
   * A member keeps one conversation for the whole session, so later tasks build on earlier ones.
   */
  readonly member?: { readonly threadId: string }
  /** The model and effort the developer picked for this agent. Absent parts are the agent's own. */
  readonly choice?: VendorModelChoice
  /** The person whose sign-in `credentials` holds, shown on the turn. */
  readonly billedTo?: string
  /**
   * True where the sandbox is the person's own and keeps their sign-in on its disk. Shuttle then
   * neither places sign-in files before a turn nor reads them back after it: `credentials` only
   * says whether the person has connected the agent.
   */
  readonly signInStaysInSandbox?: boolean
  /** Added to the agent's standing instructions: how to show a file to the people in the session. */
  readonly shareInstructions?: string
  /** Shares the files the agent left to be shown, once its turn has ended. */
  readonly collectShared?: () => Promise<readonly { path: string; result: ShareResult }[]>
  readonly sleep?: (ms: number) => Promise<void>
  readonly newRunKey?: () => string
}

/** What a conversation remembers between turns, and across a restart in the middle of one. */
interface VendorConversation {
  /** The vendor's own conversation id, so the next turn continues it. */
  readonly vendorThreadId?: string
  /** A turn that has started but whose result has not been returned yet. */
  readonly pending?: {
    readonly runKey: string
    readonly offset: number
    /** The Looms thread that started this turn, for a team member's shared conversation. */
    readonly owner?: string
  }
}

/**
 * Standing instructions for a vendor agent working inside Shuttle's sandbox. The agent's process
 * tree is stopped when its turn ends, so anything meant to keep running has to be detached.
 */
export const SANDBOX_INSTRUCTIONS = [
  'You are working inside Shuttle, in a Linux sandbox container. Your working directory is the worktree for this session.',
  'Create and edit files only inside that directory. Work anywhere else in the sandbox is not shown to the people in the session, not saved, and not shared with teammates.',
  'Any process you start is stopped when your turn ends, unless you detach it. To run a dev server or anything else that must keep running, start it detached and return immediately:',
  '  setsid nohup <command> > /tmp/<name>.log 2>&1 < /dev/null &',
  'Then confirm it is listening (for example with curl) and read its log if it is not. Never leave a server running in the foreground.',
  'Servers must listen on 0.0.0.0, not only localhost. The user opens them in the Browser tab of Shuttle by port number, so tell them the port. A localhost URL does not work for the user.',
].join('\n')

const POLL_MS = 400
/** Consecutive reads with no events from a dead process before the turn is given up. */
const DEAD_READS = 3
const STOP_WAIT_MS = 15_000

async function shortHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))

  return [...new Uint8Array(digest).slice(0, 8)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * What the agent has not read yet: every message sent since its last reply. Messages that arrive
 * while a turn runs wait for the next one, so a turn often has several.
 */
function unreadUserText(args: LlmCompleteArgs): string {
  const lastReply = args.messages.findLastIndex((message) => message.role === 'assistant')

  return args.messages
    .slice(lastReply + 1)
    .filter((message) => message.role === 'user')
    .map((message) =>
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    )
    .join('\n\n')
}

/** Shapes a vendor tool like one of Shuttle's own so the session view renders it the same way. */
export function vendorToolCall(
  tool: { id: string; kind: BridgeToolKind; title: string },
  cwd = '',
): {
  id: string
  name: string
  arguments: Record<string, string>
} {
  if (tool.kind === 'command') {
    return { id: tool.id, name: 'bash', arguments: { command: tool.title } }
  }

  if (tool.kind === 'file_change') {
    // Agents report absolute paths. Inside the session's worktree the prefix is only noise.
    const path = cwd ? tool.title.replaceAll(`${cwd.replace(/\/$/, '')}/`, '') : tool.title

    return { id: tool.id, name: 'edit_file', arguments: { path } }
  }

  if (tool.kind === 'web_search') {
    return { id: tool.id, name: 'web_search', arguments: { query: tool.title } }
  }

  return { id: tool.id, name: tool.title, arguments: {} }
}

function sameFiles(
  left: Readonly<Record<string, string>> | undefined,
  right: Readonly<Record<string, string>>,
): boolean {
  const keys = Object.keys(right)

  return (
    Object.keys(left ?? {}).length === keys.length &&
    keys.every((key) => left?.[key] === right[key])
  )
}

export async function runVendorTurn(
  deps: VendorTurnDeps,
  args: LlmCompleteArgs,
): Promise<AgentTurnResult> {
  const { harness, sandbox, storage } = deps
  const info = vendorHarnessInfo(harness)
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))

  // Each Looms agent keeps its own vendor conversation: the conductor's work must not share a
  // context with, say, the narrator answering a side question.
  // A vendor conversation lives in the home directory of the person who ran it. In a session
  // that moves between people's sandboxes, each person's turns continue their own.
  const whose = deps.signInStaysInSandbox && deps.billedTo ? `:for:${deps.billedTo}` : ''

  let conversationKey = deps.member
    ? `shuttle:vendor:${harness}${whose}:member`
    : `shuttle:vendor:${harness}${whose}:${await shortHash(args.instructions)}`

  let conversation = (await storage.get<VendorConversation>(conversationKey)) ?? {}
  const owner = deps.member?.threadId

  // The member's conversation is in use by another task (the conductor ran two at once). An
  // agent cannot take two prompts in one conversation, so this task gets one of its own. A turn
  // whose process is gone was abandoned, and its conversation is free again.
  if (deps.member && conversation.pending && conversation.pending.owner !== owner) {
    const { state } = await sandbox.agentRunState(conversation.pending.runKey)

    if (state === 'exited' || state === 'missing') {
      conversation = conversation.vendorThreadId
        ? { vendorThreadId: conversation.vendorThreadId }
        : {}
    } else {
      conversationKey = `shuttle:vendor:${harness}${whose}:thread:${owner}`
      conversation = (await storage.get<VendorConversation>(conversationKey)) ?? {}
    }
  }

  const save = async (next: VendorConversation) => {
    conversation = next
    await storage.put(conversationKey, next)
  }

  const stored = await deps.credentials.get(harness)

  // The work never falls back to someone else's sign-in. The person it is for has to connect.
  if (deps.signInStaysInSandbox && !stored && !conversation.pending) {
    return {
      message: {
        role: 'assistant',
        content: `${info.label} is not connected for the person this work is for. They can connect it on the Connections page, then send the message again.`,
      },
      usage: { input: 0, output: 0 },
    }
  }

  let pending = conversation.pending

  if (!pending) {
    const runKey = `${deps.runId.replaceAll(/[^A-Za-z0-9_-]/g, '_').slice(0, 60)}_${
      deps.newRunKey?.() ?? crypto.randomUUID()
    }`

    // Recorded before the agent starts, so a restart mid-turn rejoins this run and never
    // starts a second agent on the same prompt.
    pending = { runKey, offset: 0, ...(owner ? { owner } : {}) }
    await save({ ...conversation, pending })

    await sandbox.startAgentRun({
      runKey,
      mode: 'turn',
      request: {
        harness,
        prompt: unreadUserText(args),
        cwd: deps.cwd,
        instructions: deps.shareInstructions
          ? `${SANDBOX_INSTRUCTIONS}\n${deps.shareInstructions}`
          : SANDBOX_INSTRUCTIONS,
        ...(deps.choice?.model ? { model: deps.choice.model } : {}),
        ...(deps.choice?.effort ? { effort: deps.choice.effort } : {}),
        ...(conversation.vendorThreadId ? { vendorThreadId: conversation.vendorThreadId } : {}),
      },
      ...(stored?.env ? { env: stored.env } : {}),
      ...(stored?.files && !deps.signInStaysInSandbox ? { files: stored.files } : {}),
    })
  }

  const { runKey } = pending
  let offset = pending.offset
  const signal = args.signal
  const thinking = signal ? getThinkingObserver(signal) : undefined
  const steps = signal ? getStepObserver(signal) : undefined
  /**
   * The agent's latest message, not yet shown as a step. A turn usually has several: each is
   * recorded as its own step once something follows it, and the last becomes the turn's reply.
   */
  let heldMessage: string | undefined
  let thinkingStartedAt: number | undefined
  let usage = { input: 0, output: 0 }
  let done: Extract<BridgeEvent, { type: 'turn_done' }> | undefined
  let quietReads = 0
  let stopRequestedAt: number | undefined
  let announced = false

  thinking?.reset()

  /** Says which agent is working before its first step, so the session can name it. */
  const announce = async (model?: string) => {
    if (!announced) {
      announced = true

      await steps?.onStep({
        type: 'started',
        harness,
        label: info.label,
        ...(model ? { model } : {}),
        ...(deps.billedTo ? { billedTo: deps.billedTo } : {}),
      })
    }
  }

  const step = async (next: VendorStep) => {
    await announce()
    await steps?.onStep(next)
  }

  const releaseHeldMessage = async () => {
    if (heldMessage !== undefined) {
      const text = heldMessage

      heldMessage = undefined
      await step({ type: 'message', text })
    }
  }

  const handle = async (event: BridgeEvent) => {
    switch (event.type) {
      case 'thread': {
        await save({ ...conversation, vendorThreadId: event.vendorThreadId })
        await announce(event.model)
        break
      }

      case 'text_delta': {
        await releaseHeldMessage()
        await args.onTextDelta?.(event.delta)
        break
      }

      case 'thought_delta': {
        await releaseHeldMessage()
        thinkingStartedAt ??= Date.now()
        await thinking?.onDelta(event.delta)
        break
      }

      case 'thought': {
        await releaseHeldMessage()

        await step({
          type: 'thought',
          text: event.text,
          ...(thinkingStartedAt === undefined
            ? {}
            : { durationMs: Math.max(0, Date.now() - thinkingStartedAt) }),
        })

        thinkingStartedAt = undefined
        break
      }

      case 'message': {
        await releaseHeldMessage()
        heldMessage = event.text
        break
      }

      case 'tool_started': {
        await releaseHeldMessage()
        await step({ type: 'tool_started', toolCall: vendorToolCall(event, deps.cwd) })
        break
      }

      case 'tool_finished': {
        await step({
          type: 'tool_finished',
          toolCallId: event.id,
          result: event.output ?? '',
          // The output stays the result. The error only says how it ended.
          ...(event.status === 'completed'
            ? {}
            : {
                error: event.exitCode === undefined ? event.status : `exit code ${event.exitCode}`,
              }),
        })

        break
      }

      case 'usage': {
        usage = { input: event.input, output: event.output }
        break
      }

      case 'turn_done': {
        done = event
        break
      }

      default: {
        break
      }
    }
  }

  while (!done) {
    if (signal?.aborted && stopRequestedAt === undefined) {
      stopRequestedAt = Date.now()
      await sandbox.stopAgentRun(runKey)
    }

    const page = await sandbox.readAgentEvents(runKey, offset)

    for (const event of page.events) {
      await handle(event)
    }

    if (page.offset !== offset) {
      offset = page.offset
      quietReads = 0
      await save({ ...conversation, pending: { ...pending, offset } })
      continue
    }

    if (stopRequestedAt !== undefined && Date.now() - stopRequestedAt > STOP_WAIT_MS) {
      break
    }

    const { state } = await sandbox.agentRunState(runKey)

    quietReads = state === 'exited' || state === 'missing' ? quietReads + 1 : 0

    if (quietReads >= DEAD_READS) {
      done = {
        type: 'turn_done',
        status: 'failed',
        text: '',
        error: `the ${info.label} agent stopped without finishing`,
        seq: 0,
        at: Date.now(),
      }

      break
    }

    await sleep(POLL_MS)
  }

  await save(conversation.vendorThreadId ? { vendorThreadId: conversation.vendorThreadId } : {})

  // Agents refresh their sign-in while they work. Keep the newest copy, or the next container
  // would start from a stale one.
  if (info.credentialFiles.length > 0 && !deps.signInStaysInSandbox) {
    try {
      const { files } = await sandbox.collectAgentFiles(info.credentialFiles)

      if (Object.keys(files).length > 0 && !sameFiles(stored?.files, files)) {
        await deps.credentials.put(harness, { ...stored, files })
      }
    } catch {
      // Saving the refreshed sign-in is best effort; the turn's result still stands.
    }
  }

  if (signal?.aborted) {
    // What the agent had already said still belongs in the history of a stopped turn.
    await releaseHeldMessage()
    throw new Error('Aborted')
  }

  await announce()

  // Shown as a share_file call, so the session renders a vendor agent's files like a worker's.
  try {
    for (const { path, result } of (await deps.collectShared?.()) ?? []) {
      const id = `share_${crypto.randomUUID()}`

      await step({
        type: 'tool_started',
        toolCall: { id, name: SHARE_FILE_TOOL, arguments: { path } },
      })

      await step({
        type: 'tool_finished',
        toolCallId: id,
        result: JSON.stringify(result.ok ? { ok: true, path, asset: result.asset } : result),
        ...(result.ok ? {} : { error: result.error }),
      })
    }
  } catch {
    // Showing files is best effort; the turn's result still stands.
  }

  const text = heldMessage?.trim() || done?.text.trim() || ''

  if (done?.status === 'failed') {
    const reason = done.error ?? 'unknown error'

    const hint = /401|unauthorized|not logged in|login|authenticat/i.test(reason)
      ? ` Connect ${info.label} under Connections, then send your message again.`
      : ''

    const failure = `${info.label} could not finish this turn: ${reason}.${hint}`

    return {
      message: { role: 'assistant', content: text ? `${text}\n\n${failure}` : failure },
      usage,
    }
  }

  return {
    message: { role: 'assistant', content: text || `${info.label} finished without a message.` },
    usage,
  }
}

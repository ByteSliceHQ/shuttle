import { z } from 'zod'

import {
  SHUTTLE_PROPOSE_PULL_REQUEST,
  type BridgeEvent,
  type BridgeTurnRequest,
  type BridgePullProposal,
  type BridgeToolKind,
} from '@shuttle/sandbox/bridge/protocol'
import type { AgentTurnResult, LlmCompleteArgs } from '@swirls/looms/agent'

import type { ShareResult } from '../assets/sandbox'
import type { CredentialPayload } from '../credentials/store'
import type { SessionSandboxStub } from '../env'
import type { VendorHarnessId } from '../harness'
import { getStepObserver, getThinkingObserver, type VendorStep } from '../llm'
import { present } from '../present'
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

type Writable<T> = { -readonly [K in keyof T]: T[K] }

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
  /**
   * Where the sign-in stays in the sandbox, whether it is there. Being connected is recorded per
   * person, not per place, so a person signed in on the cloud can have a turn run on their
   * machine (or the other way round), where the agent has no sign-in.
   */
  readonly signInPresent?: () => Promise<boolean>
  /** Whether the sandbox is on the person's own machine, for saying where to sign in. */
  readonly onMachine?: boolean
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
  /** What Shuttle has to tell the agent at the start of its next turn, such as a PR's fate. */
  readonly notes?: readonly string[]
  /** A turn that has started but whose result has not been returned yet. */
  readonly pending?: {
    readonly runKey: string
    readonly offset: number
    /** The Looms thread that started this turn, for a team member's shared conversation. */
    readonly owner?: string
  }
}

/** Added to the standing instructions when the agent may propose pull requests. */
export const PULL_REQUEST_INSTRUCTIONS = [
  'To ship the work as a GitHub pull request, call propose_pull_request, the tool from the shuttle MCP server, with a title and a short description. Do it whenever the user asks for a PR.',
  'Shuttle commits anything uncommitted, pushes, and opens or updates the pull request with its own GitHub access once the user approves it in Shuttle. You have no GitHub credentials here and need none: never push, run gh, or ask for a token.',
  'Commit on the branch you are on, or leave the changes uncommitted. Do not create or switch branches.',
  'If propose_pull_request is not available, tell the user to press Open pull request at the top of the session instead.',
].join('\n')

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
    .map((message) => message.content)
    .join('\n\n')
}

export interface VendorToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: Record<string, string>
}

/** Shapes a vendor tool like one of Shuttle's own so the session view renders it the same way. */
export function vendorToolCall(
  tool: { id: string; kind: BridgeToolKind; title: string },
  cwd = '',
): VendorToolCall {
  if (tool.kind === 'command') {
    return { id: tool.id, name: 'bash', arguments: { command: tool.title } }
  }

  if (tool.kind === 'file_change') {
    // Agents report absolute paths. Inside the session's worktree the prefix is only noise.
    const path = cwd === '' ? tool.title : tool.title.replaceAll(`${cwd.replace(/\/$/, '')}/`, '')

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
  const billedTo = present(deps.billedTo)

  const whose =
    deps.signInStaysInSandbox === true && billedTo !== undefined ? `:for:${billedTo}` : ''

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
      conversation = resumable(conversation)
    } else {
      conversationKey = `shuttle:vendor:${harness}${whose}:thread:${owner}`
      conversation = (await storage.get<VendorConversation>(conversationKey)) ?? {}
    }
  }

  const save = async (next: VendorConversation) => {
    conversation = next
    await storage.put(conversationKey, next)
  }

  // Shuttle ran the pull request the agent proposed, and the person approved, published or
  // discarded it. That is the end of this turn: the agent hears how it went next time.
  const proposalResult = proposalToolResult(args)

  if (proposalResult !== null) {
    const outcome = describeProposalOutcome(proposalResult)

    await save({ ...conversation, notes: [...(conversation.notes ?? []), outcome.forAgent] })

    return {
      message: { role: 'assistant', content: outcome.forPerson },
      usage: { input: 0, output: 0 },
    }
  }

  // Only the agent running the session proposes pull requests, and only where the session has a
  // repository to open them on: then the conductor has the tool this hands the proposal to.
  const canPropose =
    !deps.member && args.tools.some((tool) => tool.name === SHUTTLE_PROPOSE_PULL_REQUEST)

  const stored = await deps.credentials.get(harness)

  if (deps.signInStaysInSandbox === true && conversation.pending === undefined) {
    // The work never falls back to someone else's sign-in. The person it is for has to connect.
    // On a machine, the sign-in is a file there and is never recorded, so only the file counts.
    if (stored === null && deps.onMachine !== true) {
      return {
        message: {
          role: 'assistant',
          content: `${info.label} is not connected for the person this work is for. They can connect it on the Connections page, then send the message again.`,
        },
        usage: { input: 0, output: 0 },
      }
    }

    // Connected somewhere, but not where this turn runs. Starting the agent would only end in
    // the vendor refusing it for want of a sign-in.
    if (deps.signInPresent && !(await deps.signInPresent().catch(() => true))) {
      return {
        message: {
          role: 'assistant',
          content:
            deps.onMachine === true
              ? `${info.label} is not signed in on this machine, where this session runs. Sign in from the message box, or move the session to the cloud, then send the message again.`
              : `${info.label} is not signed in in the cloud, where this session runs. Sign in from the message box, or move the session to your machine, then send the message again.`,
        },
        usage: { input: 0, output: 0 },
      }
    }
  }

  let pending = conversation.pending

  if (!pending) {
    const runKey = `${deps.runId.replaceAll(/[^A-Za-z0-9_-]/g, '_').slice(0, 60)}_${
      deps.newRunKey?.() ?? crypto.randomUUID()
    }`

    // Recorded before the agent starts, so a restart mid-turn rejoins this run and never
    // starts a second agent on the same prompt.
    pending = { runKey, offset: 0, owner: present(owner) }
    // Shuttle's notes go out with this prompt, once.
    const prompt = withNotes(conversation.notes, unreadUserText(args))
    const shared = present(deps.shareInstructions)
    await save({ ...withoutNotes(conversation), pending })

    const request: Writable<BridgeTurnRequest> = {
      harness,
      prompt,
      cwd: deps.cwd,
      instructions: [
        SANDBOX_INSTRUCTIONS,
        ...(canPropose ? [PULL_REQUEST_INSTRUCTIONS] : []),
        ...(shared === undefined ? [] : [shared]),
      ].join('\n'),
    }

    const model = present(deps.choice?.model)
    const effort = present(deps.choice?.effort)
    const vendorThreadId = present(conversation.vendorThreadId)

    if (canPropose) {
      request.shuttleTools = { proposePullRequest: true }
    }

    if (model !== undefined) {
      request.model = model
    }

    if (effort !== undefined) {
      request.effort = effort
    }

    if (vendorThreadId !== undefined) {
      request.vendorThreadId = vendorThreadId
    }

    const started = { runKey, mode: 'turn' as const, request }
    const withEnv = stored?.env === undefined ? started : { ...started, env: stored.env }

    await sandbox.startAgentRun(
      deps.signInStaysInSandbox === true || stored?.files === undefined
        ? withEnv
        : { ...withEnv, files: stored.files },
    )
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
  /** What the agent proposed with Shuttle's tool. The last one stands. */
  let proposal: BridgePullProposal | undefined

  thinking?.reset()

  /** Says which agent is working before its first step, so the session can name it. */
  const announce = async (model?: string) => {
    if (!announced) {
      announced = true

      await steps?.onStep({
        type: 'started',
        harness,
        label: info.label,
        model: present(model),
        billedTo,
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
          durationMs:
            thinkingStartedAt === undefined
              ? undefined
              : Math.max(0, Date.now() - thinkingStartedAt),
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
          error:
            event.status === 'completed'
              ? undefined
              : event.exitCode === undefined
                ? event.status
                : `exit code ${event.exitCode}`,
        })

        break
      }

      case 'usage': {
        usage = { input: event.input, output: event.output }
        break
      }

      case 'pr_proposed': {
        const { type: _type, seq: _seq, at: _at, ...proposed } = event

        proposal = proposed
        break
      }

      case 'turn_done': {
        done = event
        break
      }

      case 'login_prompt':
      case 'login_done':
        break
    }
  }

  while (!done) {
    if (signal?.aborted === true && stopRequestedAt === undefined) {
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

  await save(resumable(conversation))

  // Agents refresh their sign-in while they work. Keep the newest copy, or the next container
  // would start from a stale one.
  if (info.credentialFiles.length > 0 && deps.signInStaysInSandbox !== true) {
    try {
      const { files } = await sandbox.collectAgentFiles(info.credentialFiles)

      if (Object.keys(files).length > 0 && !sameFiles(stored?.files, files)) {
        await deps.credentials.put(harness, { ...stored, files })
      }
    } catch {
      // Saving the refreshed sign-in is best effort; the turn's result still stands.
    }
  }

  if (signal?.aborted === true) {
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
        error: result.ok ? undefined : result.error,
      })
    }
  } catch {
    // Showing files is best effort; the turn's result still stands.
  }

  const text = present(heldMessage?.trim()) ?? present(done?.text.trim()) ?? ''

  if (done?.status === 'failed') {
    const reason = done.error ?? 'unknown error'

    const hint = /401|unauthorized|not logged in|login|authenticat/i.test(reason)
      ? ` Connect ${info.label} under Connections, then send your message again.`
      : ''

    const failure = `${info.label} could not finish this turn: ${reason}.${hint}`

    return {
      message: { role: 'assistant', content: text === '' ? failure : `${text}\n\n${failure}` },
      usage,
    }
  }

  const content = text === '' ? `${info.label} finished without a message.` : text

  // Handed to Looms as the conductor's own call, so the person gets the same publish card a
  // Shuttle agent's proposal makes, and Shuttle publishes it the same way.
  if (proposal !== undefined && canPropose) {
    const base = { title: proposal.title, body: proposal.body, draft: proposal.draft }
    const repo = present(proposal.repo)

    const toolCalls = [
      {
        id: `vendor_pr_${proposal.id}`,
        name: SHUTTLE_PROPOSE_PULL_REQUEST,
        arguments: repo === undefined ? base : { ...base, repo },
      },
    ]

    return { message: { role: 'assistant', content, toolCalls }, toolCalls, usage }
  }

  return { message: { role: 'assistant', content }, usage }
}

/** What a conversation keeps when its turn is over: the agent's thread, and nothing else. */
function resumable(conversation: VendorConversation): VendorConversation {
  const vendorThreadId = present(conversation.vendorThreadId)

  return vendorThreadId === undefined ? {} : { vendorThreadId }
}

function withoutNotes(conversation: VendorConversation): VendorConversation {
  const { notes: _notes, ...rest } = conversation

  return rest
}

/** Puts what Shuttle has to tell the agent ahead of the person's words. */
export function withNotes(notes: readonly string[] | undefined, prompt: string): string {
  if (!notes || notes.length === 0) {
    return prompt
  }

  const told = notes.map((note) => `- ${note}`).join('\n')

  return `<shuttle_update>\n${told}\n</shuttle_update>\n\n${prompt}`
}

/**
 * The result of the pull request this agent proposed, when the conversation ends with it: Looms
 * calls the model again with the tool's result. Null for any other turn.
 */
export function proposalToolResult(args: Pick<LlmCompleteArgs, 'messages'>): string | null {
  const last = args.messages.at(-1)

  if (last?.role !== 'tool' || last.toolCallId === undefined || last.toolCallId === '') {
    return null
  }

  const call = args.messages
    .findLast(
      (message) =>
        message.role === 'assistant' &&
        message.toolCalls !== undefined &&
        message.toolCalls.length > 0,
    )
    ?.toolCalls?.find((entry) => entry.id === last.toolCallId)

  return call?.name === SHUTTLE_PROPOSE_PULL_REQUEST && call.id.startsWith('vendor_pr_')
    ? last.content
    : null
}

export interface ProposalOutcome {
  readonly forPerson: string
  readonly forAgent: string
}

/** What a proposal's result says. A part that is missing or the wrong type counts as absent. */
const ProposalResultSchema = z.object({
  pulls: z
    .array(
      z.object({
        fullName: z.string().optional().catch(undefined),
        number: z.number().optional().catch(undefined),
        url: z.string().catch(''),
        outcome: z.string().optional().catch(undefined),
      }),
    )
    .catch([]),
  error: z.string().catch(''),
  message: z.string().catch(''),
})

const NO_PROPOSAL_RESULT = { pulls: [], error: '', message: '' }

/** What became of a proposed pull request, for the person and for the agent. */
export function describeProposalOutcome(result: string): ProposalOutcome {
  const value = readProposalResult(result)

  const pulls = value.pulls.filter((pull) => pull.url !== '')

  if (pulls.length > 0) {
    const list = pulls
      .map((pull) => {
        const verb =
          pull.outcome === 'updated'
            ? 'Updated'
            : pull.outcome === 'unchanged'
              ? 'No change to'
              : 'Opened'

        return `${verb} ${pull.fullName}#${pull.number}: ${pull.url}`
      })
      .join('\n')

    return {
      forPerson: list,
      forAgent: `The pull request you proposed was published. ${list.replaceAll('\n', '; ')}`,
    }
  }

  if (value.error !== '') {
    return {
      forPerson: `The pull request could not be published: ${value.error}`,
      forAgent: `Publishing the pull request you proposed failed: ${value.error}. Fix the cause if it is in the code, then propose it again.`,
    }
  }

  if (value.message !== '' || /discard/i.test(result)) {
    return {
      forPerson: 'The pull request was discarded. Nothing was published.',
      forAgent: 'The user discarded the pull request you proposed; nothing was published.',
    }
  }

  const said = result.trim().slice(0, 500)

  return {
    forPerson: said === '' ? 'The pull request proposal ended.' : said,
    forAgent: `Your pull request proposal ended: ${said}`,
  }
}

function readProposalResult(result: string): z.infer<typeof ProposalResultSchema> {
  try {
    return ProposalResultSchema.catch(NO_PROPOSAL_RESULT).parse(JSON.parse(result))
  } catch {
    // Not JSON: say what it says.
    return NO_PROPOSAL_RESULT
  }
}

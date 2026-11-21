/**
 * The contract between the Worker and `shuttle-agent-bridge`, the program that drives a vendor
 * coding agent inside the sandbox container. The Worker writes a request file, the bridge appends
 * one JSON event per line to an events file, and the Worker tails that file by byte offset.
 *
 * This file is imported by both sides, so it must stay free of runtime imports other than
 * `json.ts`, which has none of its own. It decodes with hand-written guards, not a schema
 * library, because the bridge runs where no `node_modules` exist.
 */
import {
  booleanField,
  isJsonObject,
  numberField,
  objectField,
  parseJson,
  stringField,
  type JsonObject,
  type JsonValue,
} from './json'

export type BridgeHarness = 'codex' | 'claude-code' | 'cursor' | `acp:${string}`

export interface BridgeTurnRequest {
  readonly harness: BridgeHarness
  readonly prompt: string
  /** Working directory for the agent, normally the session worktree. */
  readonly cwd: string
  readonly model?: string
  /** How hard the model should think, in the agent's own terms (`low`, `high`, ...). */
  readonly effort?: string
  /** The vendor's own conversation id from an earlier turn. Set to continue that conversation. */
  readonly vendorThreadId?: string
  /** Extra standing instructions, such as playbook lessons. */
  readonly instructions?: string
  /** Shuttle's own tools the agent gets for this turn, served by the bridge's `mcp` mode. */
  readonly shuttleTools?: {
    /** The agent may propose a pull request; Shuttle publishes it once a person approves. */
    readonly proposePullRequest?: boolean
  }
}

/** The name of Shuttle's tool, for the agent and for the Looms conductor alike. */
export const SHUTTLE_PROPOSE_PULL_REQUEST = 'propose_pull_request'

/** A pull request the agent proposed with Shuttle's tool. */
export interface BridgePullProposal {
  readonly id: string
  readonly title: string
  readonly body: string
  readonly draft: boolean
  readonly repo?: string
}

/** A model the agent offers, as the model picker shows it. */
export interface BridgeModel {
  /** What to pass back as `model` on a turn. */
  readonly id: string
  readonly label: string
  readonly description: string
  /** Reasoning efforts this model accepts, lowest first. Empty when it takes none. */
  readonly efforts: readonly string[]
  readonly defaultEffort?: string
  /** True for the model the agent uses when none is chosen. */
  readonly isDefault?: boolean
}

export interface BridgeLoginRequest {
  readonly harness: BridgeHarness
}

const TOOL_KINDS = ['command', 'file_change', 'web_search', 'mcp', 'other'] as const
const TOOL_STATUSES = ['completed', 'failed', 'declined'] as const
const TURN_STATUSES = ['completed', 'interrupted', 'failed'] as const

export type BridgeToolKind = (typeof TOOL_KINDS)[number]
export type BridgeToolStatus = (typeof TOOL_STATUSES)[number]
export type BridgeTurnStatus = (typeof TURN_STATUSES)[number]

export type BridgeEventBody =
  | {
      readonly type: 'thread'
      readonly vendorThreadId: string
      /** The model the agent is running, when it says. */
      readonly model?: string
    }
  | { readonly type: 'text_delta'; readonly delta: string }
  | { readonly type: 'thought_delta'; readonly delta: string }
  /** A finished stretch of reasoning. Its text has already streamed as `thought_delta`s. */
  | { readonly type: 'thought'; readonly text: string }
  | { readonly type: 'message'; readonly text: string }
  | {
      readonly type: 'tool_started'
      readonly id: string
      readonly kind: BridgeToolKind
      readonly title: string
    }
  | {
      readonly type: 'tool_finished'
      readonly id: string
      readonly kind: BridgeToolKind
      readonly title: string
      readonly status: BridgeToolStatus
      readonly output?: string
      readonly exitCode?: number
    }
  /** The agent proposed a pull request. The Worker opens the publish card when the turn ends. */
  | ({ readonly type: 'pr_proposed' } & BridgePullProposal)
  | {
      readonly type: 'usage'
      readonly input: number
      readonly output: number
      readonly contextWindow?: number
    }
  | {
      readonly type: 'login_prompt'
      readonly url: string
      /** A code to enter at `url`. Empty when the agent expects a code back instead. */
      readonly code: string
      /** True when the user must paste a code from `url` back to the agent to finish. */
      readonly needsCode?: boolean
    }
  | { readonly type: 'login_done'; readonly success: boolean; readonly error?: string }
  | {
      readonly type: 'turn_done'
      readonly status: BridgeTurnStatus
      /** The agent's final message for the turn. */
      readonly text: string
      readonly error?: string
    }

/** An event as it appears in the events file. `seq` starts at 1 and has no gaps. */
export type BridgeEvent = BridgeEventBody & { readonly seq: number; readonly at: number }

export type BridgeEmit = (event: BridgeEventBody) => void

/** Events after which the bridge writes nothing more. */
export function isTerminalBridgeEvent(event: BridgeEventBody): boolean {
  return event.type === 'turn_done' || event.type === 'login_done'
}

export const BRIDGE_REQUEST_FILE = 'request.json'
export const BRIDGE_EVENTS_FILE = 'events.jsonl'
export const BRIDGE_PID_FILE = 'pid'
export const BRIDGE_LOG_FILE = 'bridge.log'
/** Shuttle's MCP server leaves the agent's pull request proposals here, one file each. */
export const BRIDGE_PROPOSALS_DIR = 'proposals'
/** The Worker writes the user's reply here when an agent asks for one, such as a sign-in code. */
export const BRIDGE_INPUT_FILE = 'input'

/** Waits for the user's reply to a prompt. Rejects if the run is aborted first. */
export type BridgeReadInput = () => Promise<string>

/** Tool output kept on an event. Longer output is cut in the middle. */
export const BRIDGE_MAX_TOOL_OUTPUT = 8_000

export function clipToolOutput(output: string): string {
  if (output.length <= BRIDGE_MAX_TOOL_OUTPUT) {
    return output
  }

  const half = Math.floor(BRIDGE_MAX_TOOL_OUTPUT / 2)
  const dropped = output.length - half * 2

  return `${output.slice(0, half)}\n… ${dropped} characters omitted …\n${output.slice(-half)}`
}

function isToolKind(value: string | undefined): value is BridgeToolKind {
  return TOOL_KINDS.some((kind) => kind === value)
}

function isToolStatus(value: string | undefined): value is BridgeToolStatus {
  return TOOL_STATUSES.some((status) => status === value)
}

function isTurnStatus(value: string | undefined): value is BridgeTurnStatus {
  return TURN_STATUSES.some((status) => status === value)
}

function isHarness(value: string | undefined): value is BridgeHarness {
  return (
    value === 'codex' ||
    value === 'claude-code' ||
    value === 'cursor' ||
    (value !== undefined && value.startsWith('acp:'))
  )
}

/** A pull request proposal as the MCP server wrote it, or undefined when it is not one. */
export function decodePullProposal(value: JsonValue | undefined): BridgePullProposal | undefined {
  if (!isJsonObject(value)) {
    return undefined
  }

  const id = stringField(value, 'id')
  const title = stringField(value, 'title')
  const body = stringField(value, 'body')
  const draft = booleanField(value, 'draft')

  if (id === undefined || title === undefined || body === undefined || draft === undefined) {
    return undefined
  }

  return { id, title, body, draft, repo: stringField(value, 'repo') }
}

function decodeEventBody(object: JsonObject): BridgeEventBody | undefined {
  const type = stringField(object, 'type')
  const text = stringField(object, 'text')
  const delta = stringField(object, 'delta')
  const id = stringField(object, 'id')
  const kind = stringField(object, 'kind')
  const title = stringField(object, 'title')
  const status = stringField(object, 'status')

  switch (type) {
    case 'thread': {
      const vendorThreadId = stringField(object, 'vendorThreadId')

      return vendorThreadId === undefined
        ? undefined
        : { type, vendorThreadId, model: stringField(object, 'model') }
    }

    case 'text_delta':

    case 'thought_delta': {
      return delta === undefined ? undefined : { type, delta }
    }

    case 'thought':

    case 'message': {
      return text === undefined ? undefined : { type, text }
    }

    case 'tool_started': {
      return id !== undefined && isToolKind(kind) && title !== undefined
        ? { type, id, kind, title }
        : undefined
    }

    case 'tool_finished': {
      return id !== undefined && isToolKind(kind) && title !== undefined && isToolStatus(status)
        ? {
            type,
            id,
            kind,
            title,
            status,
            output: stringField(object, 'output'),
            exitCode: numberField(object, 'exitCode'),
          }
        : undefined
    }

    case 'pr_proposed': {
      const proposal = decodePullProposal(object)

      return proposal === undefined ? undefined : { type, ...proposal }
    }

    case 'usage': {
      const input = numberField(object, 'input')
      const output = numberField(object, 'output')

      return input === undefined || output === undefined
        ? undefined
        : { type, input, output, contextWindow: numberField(object, 'contextWindow') }
    }

    case 'login_prompt': {
      const url = stringField(object, 'url')
      const code = stringField(object, 'code')

      return url === undefined || code === undefined
        ? undefined
        : { type, url, code, needsCode: booleanField(object, 'needsCode') }
    }

    case 'login_done': {
      const success = booleanField(object, 'success')

      return success === undefined
        ? undefined
        : { type, success, error: stringField(object, 'error') }
    }

    case 'turn_done': {
      return isTurnStatus(status)
        ? { type, status, text: text ?? '', error: stringField(object, 'error') }
        : undefined
    }

    case undefined:

    default: {
      return undefined
    }
  }
}

/** An event line from the events file, or undefined when it is not one. */
export function decodeBridgeEvent(value: JsonValue | undefined): BridgeEvent | undefined {
  if (!isJsonObject(value)) {
    return undefined
  }

  const body = decodeEventBody(value)

  // The bridge always numbers and times its events. A line without them is still an event.
  // Fields this version does not know are kept, so a newer bridge can say more than it did.
  return body === undefined
    ? undefined
    : { ...value, ...body, seq: numberField(value, 'seq') ?? 0, at: numberField(value, 'at') ?? 0 }
}

/**
 * The turn the Worker asked for, from `request.json`, or undefined when it is not one. Fields
 * the bridge does not know are left out.
 */
export function decodeTurnRequest(value: JsonValue | undefined): BridgeTurnRequest | undefined {
  if (!isJsonObject(value)) {
    return undefined
  }

  const harness = stringField(value, 'harness')
  const prompt = stringField(value, 'prompt')
  const cwd = stringField(value, 'cwd')

  if (!isHarness(harness) || prompt === undefined || cwd === undefined) {
    return undefined
  }

  const tools = objectField(value, 'shuttleTools')

  return {
    harness,
    prompt,
    cwd,
    model: stringField(value, 'model'),
    effort: stringField(value, 'effort'),
    vendorThreadId: stringField(value, 'vendorThreadId'),
    instructions: stringField(value, 'instructions'),
    shuttleTools:
      tools === undefined
        ? undefined
        : { proposePullRequest: booleanField(tools, 'proposePullRequest') },
  }
}

/** The sign-in the Worker asked for, from `request.json`, or undefined when it is not one. */
export function decodeLoginRequest(value: JsonValue | undefined): BridgeLoginRequest | undefined {
  if (!isJsonObject(value)) {
    return undefined
  }

  const harness = stringField(value, 'harness')

  return isHarness(harness) ? { harness } : undefined
}

/**
 * Splits a chunk read from the events file into whole events. A trailing partial line is left
 * for the next read: `consumed` is how many bytes of `chunk` the returned events cover.
 */
export function parseBridgeEvents(chunk: Uint8Array): ParsedBridgeEvents {
  const lastNewline = chunk.lastIndexOf(0x0a)

  if (lastNewline < 0) {
    return { events: [], consumed: 0 }
  }

  const text = new TextDecoder().decode(chunk.subarray(0, lastNewline))
  const events: BridgeEvent[] = []

  for (const line of text.split('\n')) {
    if (line.trim()) {
      const parsed = parseJson(line)

      if (parsed === undefined) {
        throw new Error(`the bridge wrote a line that is not JSON: ${line.slice(0, 200)}`)
      }

      const event = decodeBridgeEvent(parsed)

      // An event of a kind this version does not know is passed over, so a newer bridge can say
      // more than this Worker reads without stalling the turn.
      if (event !== undefined) {
        events.push(event)
      }
    }
  }

  return { events, consumed: lastNewline + 1 }
}

export interface ParsedBridgeEvents {
  readonly events: BridgeEvent[]
  readonly consumed: number
}

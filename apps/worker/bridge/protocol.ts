/**
 * The contract between the Worker and `shuttle-agent-bridge`, the program that drives a vendor
 * coding agent inside the sandbox container. The Worker writes a request file, the bridge appends
 * one JSON event per line to an events file, and the Worker tails that file by byte offset.
 *
 * This file is imported by both sides, so it must stay free of runtime imports.
 */

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

export type BridgeToolKind = 'command' | 'file_change' | 'web_search' | 'mcp' | 'other'
export type BridgeToolStatus = 'completed' | 'failed' | 'declined'
export type BridgeTurnStatus = 'completed' | 'interrupted' | 'failed'

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

/**
 * Splits a chunk read from the events file into whole events. A trailing partial line is left
 * for the next read: `consumed` is how many bytes of `chunk` the returned events cover.
 */
export function parseBridgeEvents(chunk: Uint8Array): {
  readonly events: BridgeEvent[]
  readonly consumed: number
} {
  const lastNewline = chunk.lastIndexOf(0x0a)

  if (lastNewline < 0) {
    return { events: [], consumed: 0 }
  }

  const text = new TextDecoder().decode(chunk.subarray(0, lastNewline))
  const events: BridgeEvent[] = []

  for (const line of text.split('\n')) {
    if (line.trim()) {
      events.push(JSON.parse(line) as BridgeEvent)
    }
  }

  return { events, consumed: lastNewline + 1 }
}

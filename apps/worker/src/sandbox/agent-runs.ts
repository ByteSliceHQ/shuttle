import {
  BRIDGE_EVENTS_FILE,
  BRIDGE_INPUT_FILE,
  BRIDGE_LOG_FILE,
  BRIDGE_PID_FILE,
  BRIDGE_REQUEST_FILE,
  isTerminalBridgeEvent,
  parseBridgeEvents,
  type BridgeEvent,
  type BridgeLoginRequest,
  type BridgeModel,
  type BridgeTurnRequest,
} from '../../bridge/protocol'

/**
 * Starts and follows `shuttle-agent-bridge` runs in the sandbox container.
 *
 * A run is detached from the call that starts it and writes its events to a file. Readers follow
 * that file by byte offset, so a vendor turn that lasts many minutes survives the Worker or its
 * Durable Objects restarting in the middle: the next read picks up where the last one stopped.
 */

/** The part of a Durable Object container that agent runs need. */
export interface AgentRunContainer {
  exec(
    argv: string[],
    options?: { env?: Record<string, string>; stdin?: ReadableStream },
  ): Promise<{
    output(): Promise<{ stdout: ArrayBuffer; stderr: ArrayBuffer; exitCode: number }>
  }>
}

export interface AgentRunOptions {
  /** Directory that holds one subdirectory per run. */
  readonly root?: string
  /** Path of the bridge entry point inside the container. */
  readonly bridge?: string
  /** Command that runs the bridge. */
  readonly runtime?: readonly string[]
}

export type AgentRunInput = {
  /** Stable id for the run. Starting the same key twice does not start a second run. */
  readonly runKey: string
  /** Environment for the agent, such as an API key. */
  readonly env?: Readonly<Record<string, string>>
  /** Sign-in files to place in the agent's home directory first, as base64 by relative path. */
  readonly files?: Readonly<Record<string, string>>
} & (
  | { readonly mode: 'turn'; readonly request: BridgeTurnRequest }
  | { readonly mode: 'login'; readonly request: BridgeLoginRequest }
)

export type AgentRunState = 'starting' | 'running' | 'exited' | 'missing'

export interface AgentEventsPage {
  readonly events: BridgeEvent[]
  /** Pass this as `offset` on the next read. */
  readonly offset: number
  /** True once the run's terminal event has been read. Nothing follows it. */
  readonly done: boolean
}

const DEFAULTS = {
  root: '/workspace/.shuttle/agent',
  bridge: '/opt/shuttle-bridge/main.ts',
  runtime: ['node'],
} as const

const RUN_KEY = /^[A-Za-z0-9_-]{1,120}$/
const MAX_READ_BYTES = 1024 * 1024

function runDir(runKey: string, options: AgentRunOptions): string {
  if (!RUN_KEY.test(runKey)) {
    throw new Error('invalid agent run key')
  }

  return `${options.root ?? DEFAULTS.root}/${runKey}`
}

function bridgeArgv(options: AgentRunOptions, ...args: string[]): string[] {
  return [...(options.runtime ?? DEFAULTS.runtime), options.bridge ?? DEFAULTS.bridge, ...args]
}

function textStream(text: string): ReadableStream {
  return new Blob([text]).stream()
}

async function run(
  container: AgentRunContainer,
  argv: string[],
  options?: { env?: Record<string, string>; stdin?: ReadableStream },
) {
  const output = await (await container.exec(argv, options)).output()

  return {
    stdout: new Uint8Array(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
    exitCode: output.exitCode,
  }
}

/**
 * Starts a bridge run and returns without waiting for it. The request travels on stdin and the
 * sign-in files through the bridge's `seed` mode, so no secret appears in a command line.
 */
export async function startAgentRun(
  container: AgentRunContainer,
  input: AgentRunInput,
  options: AgentRunOptions = {},
): Promise<{ started: boolean }> {
  const dir = runDir(input.runKey, options)

  if (input.files && Object.keys(input.files).length > 0) {
    const seeded = await run(container, bridgeArgv(options, 'seed'), {
      stdin: textStream(JSON.stringify(input.files)),
    })

    if (seeded.exitCode !== 0) {
      throw new Error(`could not place agent sign-in files: ${seeded.stderr.trim()}`)
    }
  }

  // The request file marks the run as started. Looms may retry the effect that starts a turn,
  // and a second agent working the same prompt in the same worktree would corrupt it.
  const script = [
    'set -e',
    'dir="$1"; shift',
    'mkdir -p "$dir"',
    `if [ -e "$dir/${BRIDGE_REQUEST_FILE}" ]; then echo existing; exit 0; fi`,
    `cat > "$dir/${BRIDGE_REQUEST_FILE}.tmp"`,
    `mv "$dir/${BRIDGE_REQUEST_FILE}.tmp" "$dir/${BRIDGE_REQUEST_FILE}"`,
    `nohup "$@" >> "$dir/${BRIDGE_LOG_FILE}" 2>&1 < /dev/null &`,
    'echo started',
  ].join('\n')

  const launched = await run(
    container,
    ['bash', '-c', script, 'bash', dir, ...bridgeArgv(options, input.mode, '--dir', dir)],
    {
      ...(input.env ? { env: { ...input.env } } : {}),
      stdin: textStream(JSON.stringify(input.request)),
    },
  )

  if (launched.exitCode !== 0) {
    throw new Error(`could not start the agent: ${launched.stderr.trim()}`)
  }

  return { started: new TextDecoder().decode(launched.stdout).trim() === 'started' }
}

/** Reads the events written since `offset`. Only whole events are returned. */
export async function readAgentEvents(
  container: AgentRunContainer,
  runKey: string,
  offset: number,
  options: AgentRunOptions = {},
): Promise<AgentEventsPage> {
  const script = `f="$1/${BRIDGE_EVENTS_FILE}"; [ -e "$f" ] || exit 0; tail -c +"$2" "$f" | head -c "$3"`

  const read = await run(container, [
    'bash',
    '-c',
    script,
    'bash',
    runDir(runKey, options),
    String(Math.max(0, Math.floor(offset)) + 1),
    String(MAX_READ_BYTES),
  ])

  const { events, consumed } = parseBridgeEvents(read.stdout)

  return { events, offset: offset + consumed, done: events.some(isTerminalBridgeEvent) }
}

/** Whether the bridge process for a run is still alive. */
export async function agentRunState(
  container: AgentRunContainer,
  runKey: string,
  options: AgentRunOptions = {},
): Promise<AgentRunState> {
  const script = [
    `[ -e "$1/${BRIDGE_REQUEST_FILE}" ] || { echo missing; exit 0; }`,
    `[ -e "$1/${BRIDGE_PID_FILE}" ] || { echo starting; exit 0; }`,
    `if kill -0 "$(cat "$1/${BRIDGE_PID_FILE}")" 2>/dev/null; then echo running; else echo exited; fi`,
  ].join('\n')

  const result = await run(container, ['bash', '-c', script, 'bash', runDir(runKey, options)])
  const state = new TextDecoder().decode(result.stdout).trim()

  return state === 'running' || state === 'starting' || state === 'missing' ? state : 'exited'
}

/** Asks a run to stop. The bridge interrupts the agent and still writes its terminal event. */
export async function stopAgentRun(
  container: AgentRunContainer,
  runKey: string,
  options: AgentRunOptions = {},
): Promise<void> {
  const script = `[ -e "$1/${BRIDGE_PID_FILE}" ] && kill -TERM "$(cat "$1/${BRIDGE_PID_FILE}")" 2>/dev/null; true`

  await run(container, ['bash', '-c', script, 'bash', runDir(runKey, options)])
}

/** Hands the run the user's reply to a prompt, such as a sign-in code. It travels on stdin. */
export async function sendAgentInput(
  container: AgentRunContainer,
  runKey: string,
  text: string,
  options: AgentRunOptions = {},
): Promise<void> {
  const script = `cat > "$1/${BRIDGE_INPUT_FILE}.tmp" && mv "$1/${BRIDGE_INPUT_FILE}.tmp" "$1/${BRIDGE_INPUT_FILE}"`

  const sent = await run(container, ['bash', '-c', script, 'bash', runDir(runKey, options)], {
    stdin: textStream(text),
  })

  if (sent.exitCode !== 0) {
    throw new Error(`could not pass the reply to the agent: ${sent.stderr.trim()}`)
  }
}

/** Reads sign-in files back out of the agent's home directory, as base64 by relative path. */
export async function collectAgentFiles(
  container: AgentRunContainer,
  paths: readonly string[],
  options: AgentRunOptions = {},
): Promise<Record<string, string>> {
  if (paths.length === 0) {
    return {}
  }

  const collected = await run(container, bridgeArgv(options, 'collect', '--paths', paths.join(',')))

  if (collected.exitCode !== 0) {
    throw new Error(`could not read agent sign-in files: ${collected.stderr.trim()}`)
  }

  return JSON.parse(new TextDecoder().decode(collected.stdout)) as Record<string, string>
}

/**
 * Asks an agent which models it offers. Throws when it cannot say, which includes a sandbox image
 * built before the bridge could ask.
 */
export async function listAgentModels(
  container: AgentRunContainer,
  harness: string,
  options: AgentRunOptions = {},
): Promise<BridgeModel[]> {
  const listed = await run(container, bridgeArgv(options, 'models', '--harness', harness))

  if (listed.exitCode !== 0) {
    throw new Error(`could not list ${harness} models: ${listed.stderr.trim()}`)
  }

  const parsed = JSON.parse(new TextDecoder().decode(listed.stdout)) as { models?: BridgeModel[] }

  return parsed.models ?? []
}

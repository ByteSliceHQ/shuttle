/**
 * What a sandbox Durable Object and a runner say to each other.
 *
 * A runner is a process on someone's own machine that keeps a sandbox there. It dials out to the
 * Durable Object named after it and holds one WebSocket open; the Durable Object sends requests
 * down that socket and the runner answers them. Nothing listens on the machine, so this works the
 * same against a Worker on the laptop and one in the cloud.
 *
 * Every frame is one JSON text message. Bytes travel as base64.
 */

export const RUNNER_PROTOCOL = 1

/** Where a runner connects, on the Worker. */
export const RUNNER_CONNECT_PATH = '/runners/connect'

/** Close code: another runner connected as this machine. */
export const RUNNER_REPLACED = 4001

/** Close code: the machine was removed from Shuttle. Its token no longer works. */
export const RUNNER_REMOVED = 4002

/** Sent by the runner as text to keep the socket open; answered with `RUNNER_PONG`. */
export const RUNNER_PING = 'ping'
export const RUNNER_PONG = 'pong'

/**
 * How strongly a local sandbox is kept apart from the machine it runs on, strongest first:
 * a virtual machine of its own, a virtual machine shared with other containers, kernel
 * namespaces on the machine's own kernel, or an operating system policy on an ordinary process.
 */
export type RunnerIsolation = 'microvm' | 'vm' | 'container' | 'process'

export interface RunnerDevice {
  readonly id: string
  readonly name: string
  readonly platform: string
  readonly arch: string
}

export interface RunnerBackendInfo {
  /** Which backend holds the sandbox, such as `docker` or `apple-container`. */
  readonly id: string
  /** How it is named to people, such as "Docker Desktop". */
  readonly label: string
  readonly isolation: RunnerIsolation
  readonly version?: string
}

/** The first frame a runner sends. */
export interface RunnerHello {
  readonly type: 'hello'
  readonly protocol: number
  readonly device: RunnerDevice
  readonly backend: RunnerBackendInfo
}

export type RunnerRequest =
  | {
      readonly op: 'exec'
      readonly argv: readonly string[]
      readonly cwd?: string
      readonly env?: Readonly<Record<string, string>>
      /** Base64. Read to its end before the command starts. */
      readonly stdin?: string
    }
  | { readonly op: 'readBytes'; readonly path: string }
  | { readonly op: 'writeBytes'; readonly path: string; readonly data: string }
  | { readonly op: 'mkdir'; readonly path: string }
  | {
      readonly op: 'http'
      readonly port: number
      readonly method: string
      /** Path and query. */
      readonly path: string
      readonly headers: readonly (readonly [string, string])[]
      readonly body?: string
    }
  | {
      readonly op: 'term.open'
      readonly term: string
      readonly cwd?: string
      readonly cols: number
      readonly rows: number
    }

export interface RunnerResults {
  readonly exec: { readonly stdout: string; readonly stderr: string; readonly exitCode: number }
  readonly readBytes: { readonly data: string }
  readonly writeBytes: Record<string, never>
  readonly mkdir: Record<string, never>
  readonly http: {
    readonly status: number
    readonly headers: readonly (readonly [string, string])[]
    readonly body: string
  }
  readonly 'term.open': Record<string, never>
}

/** From the Durable Object to the runner. */
export type RunnerInbound =
  | ({ readonly type: 'req'; readonly id: string } & RunnerRequest)
  | { readonly type: 'term.input'; readonly term: string; readonly data: string }
  | {
      readonly type: 'term.resize'
      readonly term: string
      readonly cols: number
      readonly rows: number
    }
  | { readonly type: 'term.close'; readonly term: string }

/** From the runner to the Durable Object. */
export type RunnerOutbound =
  | RunnerHello
  /** An `exec` has started; `pid` is the command's process id inside the sandbox. */
  | { readonly type: 'started'; readonly id: string; readonly pid: number }
  | { readonly type: 'res'; readonly id: string; readonly ok: true; readonly result: unknown }
  | {
      readonly type: 'res'
      readonly id: string
      readonly ok: false
      readonly error: string
      /** `ENOENT` when a file that was asked for does not exist. */
      readonly code?: string
    }
  | { readonly type: 'term.data'; readonly term: string; readonly data: string }
  | { readonly type: 'term.exit'; readonly term: string }

/** A device id as a runner may choose it. It becomes part of a Durable Object name. */
export const DEVICE_ID = /^[A-Za-z0-9_-]{6,64}$/

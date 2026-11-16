import type { RunnerBackendInfo } from '@shuttle/runner-protocol'

/**
 * A way of keeping a sandbox on this machine, apart from everything else on it.
 *
 * The runner speaks to Shuttle; a backend is what it runs the sandbox on. Each one is a real
 * Linux environment with the session's files at `/workspace`, which is what lets a session move
 * between this machine and the cloud without anything in it noticing. Which backend is used is
 * decided at start by what the machine has (see `detect.ts`), strongest isolation first.
 */
export interface LocalBackend {
  readonly info: RunnerBackendInfo
  /** Brings the sandbox up, creating it the first time. Safe to call before every use. */
  ensure(): Promise<void>
  /**
   * Called when the runner stops. A backend whose sandbox would otherwise go on using this
   * machine with nobody connected to it puts it to rest here; its files stay.
   */
  rest?(): Promise<void>
  /** Deletes the sandbox and everything in it: the session files and the agent sign-ins. */
  destroy(): Promise<void>
  exec(
    argv: readonly string[],
    options: {
      readonly cwd?: string
      readonly env?: Readonly<Record<string, string>>
      readonly stdin?: Uint8Array
      /** Called with the command's process id inside the sandbox once it is running. */
      readonly started?: (pid: number) => void
    },
  ): Promise<ExecOutput>
  /** Rejects with a `MissingFileError` when there is no such file. */
  readBytes(path: string): Promise<Uint8Array>
  writeBytes(path: string, data: Uint8Array): Promise<void>
  mkdir(path: string): Promise<void>
  /** One HTTP request to a port inside the sandbox. */
  http(request: SandboxHttpRequest): Promise<SandboxHttpResponse>
  openTerminal(options: {
    readonly cwd?: string
    readonly cols: number
    readonly rows: number
    readonly data: (bytes: Uint8Array) => void
    readonly exit: () => void
  }): Promise<LocalTerminal>
}

export interface ExecOutput {
  readonly stdout: Uint8Array
  readonly stderr: Uint8Array
  readonly exitCode: number
}

export interface SandboxHttpRequest {
  readonly port: number
  readonly method: string
  readonly path: string
  readonly headers: readonly (readonly [string, string])[]
  /** Base64. */
  readonly body?: string
}

export interface SandboxHttpResponse {
  readonly status: number
  readonly headers: readonly (readonly [string, string])[]
  /** Base64. */
  readonly body: string
}

export interface LocalTerminal {
  write(bytes: Uint8Array): void
  resize(cols: number, rows: number): void
  close(): void
}

export class MissingFileError extends Error {
  readonly code = 'ENOENT'

  constructor(path: string) {
    super(`no such file or directory, open '${path}'`)
  }
}

/** What a backend needs to know about the sandbox it keeps. */
export interface SandboxSpec {
  /** Names the sandbox's container and volumes. One per person, organization and Shuttle. */
  readonly key: string
  /**
   * The image with the agent CLIs and the bridge, the same one cloud sandboxes run. A backend
   * that starts from a plain image and installs those itself does not use it.
   */
  readonly image: string
  /** Where to build `image` from when the machine does not have it. Without it, it is pulled. */
  readonly buildContext?: string
  /** The most the sandbox may use of this machine. Unset leaves it to the engine. */
  readonly limits?: { readonly cpus?: number; readonly memoryMb?: number }
  readonly log: (line: string) => void
}

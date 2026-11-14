import { Files } from '@cloudflare/sandbox'

import type { DurableContainer } from './container-runtime'

/**
 * The machine a workspace runs on: somewhere to run commands and read and write files. The
 * workspace, the agent runs and the stack operations are written against this, so the same code
 * drives a Cloudflare container and a Daytona sandbox.
 */
export interface SandboxHost {
  /** Starts `argv` and returns at once. `stdin`, when given, is read to its end first. */
  exec(
    argv: string[],
    options?: {
      readonly cwd?: string
      readonly env?: Readonly<Record<string, string>>
      readonly stdin?: ReadableStream
    },
  ): Promise<HostProcess>
  /** The file's text. Rejects when the file does not exist. */
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  /** Creates the directory and any missing parents. */
  mkdir(path: string): Promise<void>
}

export interface HostProcess {
  /** The process id on the host, when the host can report one. Needed to interrupt it. */
  readonly pid?: number
  output(): Promise<HostOutput>
}

export interface HostOutput {
  readonly stdout: ArrayBuffer
  readonly stderr: ArrayBuffer
  readonly exitCode: number
}

/** A Durable Object's own container as a host. */
export function cloudflareHost(container: DurableContainer): SandboxHost {
  const files = new Files(container)

  return {
    async exec(argv, options) {
      const process = await container.exec(argv, {
        ...(options?.cwd ? { cwd: options.cwd } : {}),
        ...(options?.env ? { env: { ...options.env } } : {}),
        ...(options?.stdin ? { stdin: options.stdin } : {}),
      })

      return {
        ...(typeof process.pid === 'number' ? { pid: process.pid } : {}),
        async output() {
          const output = await process.output()

          return {
            stdout: output.stdout,
            stderr: output.stderr ?? new ArrayBuffer(0),
            exitCode: output.exitCode ?? 0,
          }
        },
      }
    },
    readFile: async (path) => (await files.readFile(path)).text(),
    writeFile: async (path, content) => {
      await files.writeFile(path, content)
    },
    mkdir: async (path) => {
      await files.mkdir(path, { recursive: true })
    },
  }
}

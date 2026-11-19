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
  /** The file's bytes, for files that are not text. Rejects when the file does not exist. */
  readBytes(path: string): Promise<Uint8Array>
  /** Writes bytes to a file whose directory already exists. */
  writeBytes(path: string, content: Uint8Array): Promise<void>
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
      const execOptions: ContainerExecOptions = {}

      if (options?.cwd !== undefined && options.cwd !== '') {
        execOptions.cwd = options.cwd
      }

      if (options?.env !== undefined) {
        execOptions.env = { ...options.env }
      }

      if (options?.stdin !== undefined) {
        execOptions.stdin = options.stdin
      }

      const process = await container.exec(argv, execOptions)

      return {
        pid: process.pid,
        async output() {
          const output = await process.output()

          return { stdout: output.stdout, stderr: output.stderr, exitCode: output.exitCode }
        },
      }
    },
    readFile: async (path) => (await files.readFile(path)).text(),
    writeFile: async (path, content) => {
      await files.writeFile(path, content)
    },
    // The container's file API is for text. A process's output and input are bytes.
    readBytes: async (path) => {
      const output = await (await container.exec(['cat', '--', path])).output()

      if (output.exitCode !== 0) {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`)
      }

      return new Uint8Array(output.stdout)
    },
    writeBytes: async (path, content) => {
      const stdin = new Blob([new Uint8Array(content)]).stream()

      const output = await (
        await container.exec(['bash', '-c', 'cat > "$1"', 'bash', path], { stdin })
      ).output()

      if (output.exitCode !== 0) {
        throw new Error(`could not write ${path}`)
      }
    },
    mkdir: async (path) => {
      await files.mkdir(path, { recursive: true })
    },
  }
}

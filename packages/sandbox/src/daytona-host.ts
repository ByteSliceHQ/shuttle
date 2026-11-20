import { shellQuote } from './exec-argv'
import type { HostOutput, SandboxHost } from './host'

/**
 * A Daytona sandbox as a `SandboxHost`.
 *
 * Daytona runs a command and returns its output as one string, with no stdin and no separate
 * stderr. Each command is therefore wrapped in a small script that feeds it stdin from a file and
 * appends stderr after a marker, so callers get what they would from a local process.
 */

/** The part of a Daytona sandbox this host uses. The SDK's `Sandbox` satisfies it. */
export interface DaytonaSandboxLike {
  readonly process: {
    executeCommand(
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeout?: number,
    ): Promise<{ exitCode: number; result: string }>
  }
  readonly fs: {
    uploadFile(file: Uint8Array, remotePath: string): Promise<void>
    downloadFile(remotePath: string): Promise<Uint8Array>
  }
}

/** Longest a single command may run, in seconds. Longer work is started detached and followed. */
const COMMAND_TIMEOUT_SECONDS = 660

const encoder = new TextEncoder()

function bytes(text: string): ArrayBuffer {
  const encoded = encoder.encode(text)
  const copy = new ArrayBuffer(encoded.byteLength)

  new Uint8Array(copy).set(encoded)

  return copy
}

async function readAll(stream: ReadableStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * The script that runs `argv`, for `bash -c`. Its output is the command's stdout, then a line
 * holding `marker`, then the command's stderr; it exits with the command's exit code.
 */
export function wrappedCommand(
  argv: readonly string[],
  files: { readonly marker: string; readonly stderr: string; readonly stdin?: string },
): string {
  const command = argv.map(shellQuote).join(' ')
  const input = files.stdin === undefined ? ' < /dev/null' : ` < ${shellQuote(files.stdin)}`

  const cleanup = [files.stderr, ...(files.stdin === undefined ? [] : [files.stdin])]
    .map(shellQuote)
    .join(' ')

  return [
    `${command}${input} 2> ${shellQuote(files.stderr)}`,
    'code=$?',
    `printf '\\n%s\\n' ${shellQuote(files.marker)}`,
    `cat ${shellQuote(files.stderr)} 2>/dev/null`,
    `rm -f ${cleanup}`,
    'exit "$code"',
  ].join('\n')
}

/** Splits what `wrappedCommand` printed back into stdout and stderr. */
export function splitOutput(
  output: string,
  marker: string,
): { stdout: string; stderr: string } | null {
  const at = output.lastIndexOf(`\n${marker}\n`)

  if (at < 0) {
    return null
  }

  return { stdout: output.slice(0, at), stderr: output.slice(at + marker.length + 2) }
}

export function daytonaHost(sandbox: DaytonaSandboxLike): SandboxHost {
  const run = async (
    argv: string[],
    options?: {
      readonly cwd?: string
      readonly env?: Readonly<Record<string, string>>
      readonly stdin?: ReadableStream
    },
  ): Promise<HostOutput> => {
    const id = crypto.randomUUID()
    const marker = `__shuttle_${id}__`
    const stderr = `/tmp/.shuttle-${id}.err`
    const stdin = options?.stdin === undefined ? undefined : `/tmp/.shuttle-${id}.in`

    if (options?.stdin !== undefined && stdin !== undefined) {
      await sandbox.fs.uploadFile(await readAll(options.stdin), stdin)
    }

    const response = await sandbox.process.executeCommand(
      `bash -c ${shellQuote(wrappedCommand(argv, { marker, stderr, stdin }))}`,
      options?.cwd,
      options?.env === undefined ? undefined : { ...options.env },
      COMMAND_TIMEOUT_SECONDS,
    )

    const split = splitOutput(response.result, marker)

    // No marker means the wrapper itself did not finish: the sandbox cut the command off.
    return split
      ? { stdout: bytes(split.stdout), stderr: bytes(split.stderr), exitCode: response.exitCode }
      : {
          stdout: bytes(response.result),
          stderr: bytes('The sandbox ended the command before it finished.\n'),
          exitCode: response.exitCode === 0 ? 1 : response.exitCode,
        }
  }

  return {
    async exec(argv, options) {
      // Started now, so a caller that never awaits the output still ran the command.
      const output = run(argv, options)

      output.catch(() => {})

      return { output: () => output }
    },

    async readFile(path) {
      try {
        return new TextDecoder('utf-8', { ignoreBOM: true, fatal: false }).decode(
          await sandbox.fs.downloadFile(path),
        )
      } catch (cause) {
        // Callers tell a missing file from other failures by this prefix.
        throw new Error(`ENOENT: no such file or directory, open '${path}'`, { cause })
      }
    },

    async writeFile(path, content) {
      await sandbox.fs.uploadFile(encoder.encode(content), path)
    },

    async readBytes(path) {
      try {
        return new Uint8Array(await sandbox.fs.downloadFile(path))
      } catch (cause) {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`, { cause })
      }
    },

    async writeBytes(path, content) {
      await sandbox.fs.uploadFile(content, path)
    },

    async mkdir(path) {
      const made = await run(['mkdir', '-p', path])

      if (made.exitCode !== 0) {
        throw new Error(`could not create ${path}: ${new TextDecoder().decode(made.stderr).trim()}`)
      }
    },
  }
}

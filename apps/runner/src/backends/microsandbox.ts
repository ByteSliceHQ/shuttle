import { existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { availableParallelism, homedir, totalmem } from 'node:os'
import { dirname, join } from 'node:path'

import { z } from 'zod'

import type { RunnerBackendInfo } from '@shuttle/runner-protocol'

import {
  MissingFileError,
  type ExecOutput,
  type LocalBackend,
  type LocalTerminal,
  type SandboxHttpRequest,
  type SandboxHttpResponse,
  type SandboxSpec,
} from '../backend'
import {
  BASE_IMAGE,
  BRIDGE_PATH,
  bridgeDigest,
  findBridge,
  stageBridge,
  TOOLS_SCRIPT,
  toolsDigest,
} from '../provision'
import { nonEmpty } from '../text'
import {
  ANNOUNCE_PID,
  collect,
  HTTP_SCRIPT,
  readAnnouncedPid,
  sandboxHttpResponseSchema,
  stdinOf,
  text,
} from './shared'

/** What `msb inspect --format json` says about a sandbox. */
const sandboxStatusSchema = z.object({ status: z.string().optional() })

/**
 * A sandbox in a small virtual machine of its own, kept by microsandbox (`msb`).
 *
 * This is the backend that needs nothing installed: the runtime is two files that ship with
 * the app, and each sandbox is a Linux guest started as an ordinary child process on the
 * machine's own hypervisor. The guest has its own kernel, sees none of this machine's files,
 * and reaches the network through the runtime rather than the host's interfaces.
 *
 * It starts from a public base image and installs the agent tools itself (see `provision.ts`).
 * Its root disk and its `/workspace` volume stay on this machine between runs, so tools,
 * session files and agent sign-ins are still there the next time.
 */

const MARKERS = '/opt/shuttle'
const ROOT_DISK = '32G'
const GUEST_PATH = '/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

export interface MicrosandboxRuntime {
  readonly msb: string
  readonly libkrunfw: string
}

/**
 * The runtime this runner can use: `SHUTTLE_MSB_DIR`, else beside the runner in a packaged
 * app, else the package installed in this repository. Null on a machine it does not support.
 */
export function findMicrosandbox(): MicrosandboxRuntime | null {
  const folders = [process.env.SHUTTLE_MSB_DIR, join(dirname(process.execPath), 'microsandbox')]

  try {
    const manifest = createRequire(import.meta.url).resolve(
      `@superradcompany/microsandbox-${process.platform}-${process.arch}/package.json`,
    )

    folders.push(dirname(manifest))
  } catch {
    // Not installed for this platform.
  }

  const library = process.platform === 'darwin' ? 'libkrunfw.5.dylib' : 'libkrunfw.so.5'

  for (const folder of folders) {
    if (folder === undefined || folder === '') {
      continue
    }

    const runtime = { msb: join(folder, 'bin', 'msb'), libkrunfw: join(folder, 'lib', library) }

    if (existsSync(runtime.msb) && existsSync(runtime.libkrunfw)) {
      return runtime
    }
  }

  return null
}

/**
 * Where the runtime keeps images, disks and volumes. It has to be a short path: the runtime
 * puts Unix sockets under it, and those have a length limit.
 */
function runtimeHome(): string {
  return process.env.SHUTTLE_MSB_HOME ?? join(homedir(), '.shuttle', 'msb')
}

export class MicrosandboxBackend implements LocalBackend {
  private readonly name: string
  private readonly volume: string
  private readonly env: Record<string, string>
  private ready: Promise<void> | null = null

  constructor(
    private readonly runtime: MicrosandboxRuntime,
    readonly info: RunnerBackendInfo,
    private readonly spec: SandboxSpec,
  ) {
    this.name = `shuttle-${spec.key}`
    this.volume = `${this.name}-workspace`

    const home = runtimeHome()

    mkdirSync(home, { recursive: true })

    this.env = {
      MSB_HOME: home,
      MSB_PATH: runtime.msb,
      MSB_LIBKRUNFW_PATH: runtime.libkrunfw,
    }
  }

  /** Runs `msb` and collects what it prints. Output arrives when the command has ended. */
  private async cli(
    args: readonly string[],
    options: { readonly stdin?: Uint8Array } = {},
  ): Promise<ExecOutput> {
    const child = Bun.spawn([this.runtime.msb, ...args], {
      stdin: stdinOf(options.stdin),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...this.env },
    })

    const [stdout, stderr, exitCode] = await Promise.all([
      collect(child.stdout),
      collect(child.stderr),
      child.exited,
    ])

    return { stdout, stderr, exitCode }
  }

  private async must(
    args: readonly string[],
    what: string,
    options: { readonly stdin?: Uint8Array } = {},
  ): Promise<string> {
    const result = await this.cli(args, options)

    if (result.exitCode !== 0) {
      const said = nonEmpty(text(result.stderr).trim()) ?? text(result.stdout).trim()

      throw new Error(
        `Could not ${what}: ${nonEmpty(said.slice(-2000)) ?? `exit ${result.exitCode}`}`,
      )
    }

    return text(result.stdout).trim()
  }

  /** A command inside the sandbox. A stopped sandbox is started by the runtime to run it. */
  private inGuest(
    argv: readonly string[],
    options: { readonly stdin?: Uint8Array } = {},
  ): Promise<ExecOutput> {
    return this.cli(
      [
        'exec',
        '--quiet',
        '--no-tty',
        ...(options.stdin === undefined ? ['--no-stdin'] : []),
        this.name,
        '--',
        ...argv,
      ],
      options,
    )
  }

  ensure(): Promise<void> {
    this.ready ??= this.start().catch((cause: unknown) => {
      this.ready = null

      throw cause
    })

    return this.ready
  }

  private async start(): Promise<void> {
    const found = await this.cli(['inspect', this.name, '--format', 'json'])

    if (found.exitCode !== 0) {
      await this.create()
    } else if (sandboxStatusSchema.parse(JSON.parse(text(found.stdout))).status !== 'Running') {
      await this.must(['start', this.name], 'start the sandbox')
    }

    await this.provision()
  }

  private async create(): Promise<void> {
    const cores = availableParallelism()
    const cpus = this.spec.limits?.cpus ?? Math.max(2, Math.min(8, Math.floor(cores / 2)))

    // A ceiling, not a reservation: the guest takes memory from the machine as it uses it.
    const memoryMb =
      this.spec.limits?.memoryMb ?? Math.min(8192, Math.floor(totalmem() / 2 / 1024 / 1024))

    this.spec.log('Downloading the sandbox’s Linux system')

    await this.must(
      [
        'create',
        '--quiet',
        '--name',
        this.name,
        '--hostname',
        'shuttle',
        '--cpus',
        String(Math.max(1, Math.min(cores, Math.round(cpus)))),
        '--memory',
        `${Math.round(memoryMb)}M`,
        '--root-disk',
        ROOT_DISK,
        '--mount-named',
        `${this.volume}:/workspace`,
        '--workdir',
        '/workspace',
        '--env',
        `PATH=${GUEST_PATH}`,
        BASE_IMAGE,
      ],
      'create the sandbox',
    )
  }

  private async marker(name: string): Promise<string> {
    const result = await this.inGuest(['cat', `${MARKERS}/${name}`])

    return result.exitCode === 0 ? text(result.stdout).trim() : ''
  }

  private async mark(name: string, value: string): Promise<void> {
    await this.must(
      [
        'exec',
        '--quiet',
        '--no-tty',
        '--no-stdin',
        this.name,
        '--',
        'bash',
        '-c',
        'mkdir -p "$1" && printf "%s\\n" "$3" > "$1/$2"',
        'bash',
        MARKERS,
        name,
        value,
      ],
      'record what the sandbox has',
    )
  }

  /** Puts the agent tools and the bridge in the sandbox, when it lacks them or they changed. */
  private async provision(): Promise<void> {
    const tools = toolsDigest()

    if ((await this.marker('tools')) !== tools) {
      this.spec.log('Installing Claude Code, Codex and Cursor in the sandbox')

      await this.must(['exec', '--quiet', '--no-tty', this.name, '--', 'bash'], 'install tools', {
        stdin: new TextEncoder().encode(TOOLS_SCRIPT),
      })

      await this.mark('tools', tools)
    }

    const source = findBridge()

    if (source === null) {
      throw new Error('This runner has no copy of the agent bridge to put in the sandbox.')
    }

    const bridge = bridgeDigest(source)

    if ((await this.marker('bridge')) !== bridge) {
      this.spec.log('Finishing the sandbox')

      const staged = stageBridge(source)

      try {
        await this.must(
          ['exec', '--quiet', '--no-tty', '--no-stdin', this.name, '--', 'rm', '-rf', BRIDGE_PATH],
          'replace the agent bridge',
        )

        await this.must(
          ['copy', staged.path, `${this.name}:${BRIDGE_PATH}`],
          'copy the agent bridge',
        )
      } finally {
        staged.discard()
      }

      await this.mark('bridge', bridge)
    }
  }

  async rest(): Promise<void> {
    this.ready = null
    await this.cli(['stop', this.name])
  }

  async destroy(): Promise<void> {
    this.ready = null
    await this.cli(['remove', '--force', this.name])
    await this.cli(['volume', 'remove', this.volume])
  }

  async exec(
    argv: readonly string[],
    options: {
      readonly cwd?: string
      readonly env?: Readonly<Record<string, string>>
      readonly stdin?: Uint8Array
      readonly started?: (pid: number) => void
    },
  ): Promise<ExecOutput> {
    await this.ensure()

    const env = options.env ?? {}
    const workdir = nonEmpty(options.cwd)

    const child = Bun.spawn(
      [
        this.runtime.msb,
        'exec',
        '--quiet',
        // Without this the runtime holds everything the command prints until it ends, and the
        // pid that lets a command be stopped would arrive too late to be of use.
        '--stream',
        ...(workdir === undefined ? [] : ['--workdir', workdir]),
        // Named, not given: the runtime takes each value from its own environment, so a secret
        // never appears in a command line another process on this machine could read.
        ...Object.keys(env).flatMap((name) => ['--env', name]),
        this.name,
        '--',
        'bash',
        '-c',
        ANNOUNCE_PID,
        'bash',
        ...argv,
      ],
      {
        stdin: stdinOf(options.stdin),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, ...this.env, ...env },
      },
    )

    const [stdout, stderr, exitCode] = await Promise.all([
      collect(child.stdout),
      readAnnouncedPid(child.stderr, options.started),
      child.exited,
    ])

    return { stdout, stderr, exitCode }
  }

  async readBytes(path: string): Promise<Uint8Array> {
    await this.ensure()

    const result = await this.inGuest(['cat', '--', path])

    if (result.exitCode !== 0) {
      throw new MissingFileError(path)
    }

    return result.stdout
  }

  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    await this.ensure()

    const result = await this.inGuest(['bash', '-c', 'cat > "$1"', 'bash', path], { stdin: data })

    if (result.exitCode !== 0) {
      throw new Error(`could not write ${path}: ${text(result.stderr).trim()}`)
    }
  }

  async mkdir(path: string): Promise<void> {
    await this.ensure()

    const result = await this.inGuest(['mkdir', '-p', '--', path])

    if (result.exitCode !== 0) {
      throw new Error(`could not create ${path}: ${text(result.stderr).trim()}`)
    }
  }

  async http(request: SandboxHttpRequest): Promise<SandboxHttpResponse> {
    await this.ensure()

    const result = await this.inGuest(['node', '-e', HTTP_SCRIPT], {
      stdin: new TextEncoder().encode(JSON.stringify(request)),
    })

    if (result.exitCode !== 0) {
      throw new Error(
        nonEmpty(text(result.stderr).trim()) ?? `nothing answered on port ${request.port}`,
      )
    }

    return sandboxHttpResponseSchema.parse(JSON.parse(text(result.stdout)))
  }

  async openTerminal(options: {
    readonly cwd?: string
    readonly cols: number
    readonly rows: number
    readonly data: (bytes: Uint8Array) => void
    readonly exit: () => void
  }): Promise<LocalTerminal> {
    await this.ensure()

    // A session's files are only here once it has worked here.
    const cwd = nonEmpty(options.cwd)
    const there = cwd === undefined ? null : await this.inGuest(['test', '-d', cwd])

    const child = Bun.spawn(
      [
        this.runtime.msb,
        'exec',
        '--quiet',
        '--tty',
        '--workdir',
        there?.exitCode === 0 && cwd !== undefined ? cwd : '/workspace',
        '--env',
        'TERM=xterm-256color',
        '--env',
        'COLORTERM=truecolor',
        '--env',
        'LANG=C.UTF-8',
        this.name,
        '--',
        'bash',
        '-l',
      ],
      {
        env: { ...process.env, ...this.env },
        terminal: {
          cols: options.cols,
          rows: options.rows,
          data: (_terminal, bytes) => options.data(bytes),
        },
      },
    )

    void child.exited.then(options.exit, options.exit)

    return {
      write: (bytes) => {
        child.terminal?.write(bytes)
      },
      resize: (cols, rows) => {
        child.terminal?.resize(cols, rows)
      },
      close: () => {
        child.kill()
        child.terminal?.close()
      },
    }
  }
}

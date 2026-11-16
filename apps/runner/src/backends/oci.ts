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
import { ANNOUNCE_PID, collect, HTTP_SCRIPT, readAnnouncedPid, text } from './shared'

/**
 * A sandbox in a container, driven through a Docker-compatible command line (`docker`, `podman`).
 *
 * On macOS and Windows the container engine runs inside a Linux virtual machine, so the sandbox
 * is separated from this machine by a hypervisor; on Linux it is separated by kernel namespaces.
 * Either way it sees none of this machine's files: its `/workspace` and home directory are
 * volumes the engine keeps, nothing from the host is mounted, and the engine's own socket is not
 * shared with it. It does have the network, which agents need.
 *
 * The container outlives the runner and keeps its volumes when it is removed, so a session's
 * files and an agent's sign-in are still there the next time.
 */

export class OciBackend implements LocalBackend {
  private readonly container: string
  private ready: Promise<void> | null = null

  constructor(
    private readonly bin: string,
    readonly info: RunnerBackendInfo,
    private readonly spec: SandboxSpec,
  ) {
    this.container = `shuttle-${spec.key}`
  }

  /** Runs the engine's command line and collects what it prints. */
  private async cli(
    args: readonly string[],
    options: { readonly stdin?: Uint8Array; readonly env?: Readonly<Record<string, string>> } = {},
  ): Promise<ExecOutput> {
    const child = Bun.spawn([this.bin, ...args], {
      stdin: options.stdin ? new Blob([options.stdin as Uint8Array<ArrayBuffer>]) : 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...options.env },
    })

    const [stdout, stderr, exitCode] = await Promise.all([
      collect(child.stdout),
      collect(child.stderr),
      child.exited,
    ])

    return { stdout, stderr, exitCode }
  }

  private async must(args: readonly string[], what: string): Promise<string> {
    const result = await this.cli(args)

    if (result.exitCode !== 0) {
      throw new Error(
        `Could not ${what}: ${text(result.stderr).trim() || `exit ${result.exitCode}`}`,
      )
    }

    return text(result.stdout).trim()
  }

  ensure(): Promise<void> {
    this.ready ??= this.start().catch((cause: unknown) => {
      this.ready = null

      throw cause
    })

    return this.ready
  }

  private async start(): Promise<void> {
    const state = await this.cli(['inspect', '--format', '{{.State.Running}}', this.container])

    if (state.exitCode === 0) {
      if (text(state.stdout).trim() !== 'true') {
        await this.must(['start', this.container], 'start the sandbox')
      }

      return
    }

    await this.ensureImage()
    this.spec.log(`creating sandbox ${this.container}`)

    await this.must(
      [
        'run',
        '--detach',
        '--name',
        this.container,
        '--label',
        'sh.shuttle.sandbox=local',
        '--hostname',
        'shuttle',
        // Reaps what agents leave behind: their servers outlive the command that started them.
        '--init',
        '--pids-limit',
        '4096',
        ...(this.spec.limits?.cpus ? ['--cpus', String(this.spec.limits.cpus)] : []),
        ...(this.spec.limits?.memoryMb ? ['--memory', `${this.spec.limits.memoryMb}m`] : []),
        '--volume',
        `${this.container}-workspace:/workspace`,
        // An agent's sign-in lives in its home directory and stays on this machine.
        '--volume',
        `${this.container}-home:/root`,
        '--workdir',
        '/workspace',
        this.spec.image,
        'sleep',
        'infinity',
      ],
      'create the sandbox',
    )
  }

  async destroy(): Promise<void> {
    this.ready = null
    await this.cli(['rm', '--force', this.container])

    await this.cli([
      'volume',
      'rm',
      '--force',
      `${this.container}-workspace`,
      `${this.container}-home`,
    ])
  }

  private async ensureImage(): Promise<void> {
    const { image, buildContext } = this.spec

    if ((await this.cli(['image', 'inspect', image])).exitCode === 0) {
      return
    }

    if (buildContext) {
      this.spec.log(`building ${image} from ${buildContext}; the first build takes a few minutes`)
      await this.must(['build', '--tag', image, buildContext], `build ${image}`)

      return
    }

    this.spec.log(`pulling ${image}`)
    await this.must(['pull', image], `pull ${image}`)
  }

  /** Runs an engine command against the sandbox, bringing it back up once if it had stopped. */
  private async inSandbox(
    args: (container: string) => readonly string[],
    options: { readonly stdin?: Uint8Array; readonly env?: Readonly<Record<string, string>> } = {},
  ): Promise<ExecOutput> {
    await this.ensure()

    const result = await this.cli(args(this.container), options)

    if (result.exitCode === 0 || !/is not running|No such container/i.test(text(result.stderr))) {
      return result
    }

    this.ready = null
    await this.ensure()

    return this.cli(args(this.container), options)
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

    const child = Bun.spawn(
      [
        this.bin,
        'exec',
        '--interactive',
        ...(options.cwd ? ['--workdir', options.cwd] : []),
        // Named, not given: the engine takes each value from its own environment, so a secret
        // never appears in a command line another process on this machine could read.
        ...Object.keys(env).flatMap((name) => ['--env', name]),
        this.container,
        'bash',
        '-c',
        ANNOUNCE_PID,
        'bash',
        ...argv,
      ],
      {
        stdin: options.stdin ? new Blob([options.stdin as Uint8Array<ArrayBuffer>]) : 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, ...env },
      },
    )

    const [out, err, exitCode] = await Promise.all([
      collect(child.stdout),
      readAnnouncedPid(child.stderr, options.started),
      child.exited,
    ])

    return { stdout: out, stderr: err, exitCode }
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const result = await this.inSandbox((container) => ['exec', container, 'cat', '--', path])

    if (result.exitCode !== 0) {
      throw new MissingFileError(path)
    }

    return result.stdout
  }

  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    const result = await this.inSandbox(
      (container) => ['exec', '--interactive', container, 'bash', '-c', 'cat > "$1"', 'bash', path],
      { stdin: data },
    )

    if (result.exitCode !== 0) {
      throw new Error(`could not write ${path}: ${text(result.stderr).trim()}`)
    }
  }

  async mkdir(path: string): Promise<void> {
    const result = await this.inSandbox((container) => [
      'exec',
      container,
      'mkdir',
      '-p',
      '--',
      path,
    ])

    if (result.exitCode !== 0) {
      throw new Error(`could not create ${path}: ${text(result.stderr).trim()}`)
    }
  }

  async http(request: SandboxHttpRequest): Promise<SandboxHttpResponse> {
    const result = await this.inSandbox(
      (container) => ['exec', '--interactive', container, 'node', '-e', HTTP_SCRIPT],
      { stdin: new TextEncoder().encode(JSON.stringify(request)) },
    )

    if (result.exitCode !== 0) {
      throw new Error(text(result.stderr).trim() || `nothing answered on port ${request.port}`)
    }

    return JSON.parse(text(result.stdout)) as SandboxHttpResponse
  }

  async openTerminal(options: {
    readonly cwd?: string
    readonly cols: number
    readonly rows: number
    readonly data: (bytes: Uint8Array) => void
    readonly exit: () => void
  }): Promise<LocalTerminal> {
    // A session's files are only here once it has worked here.
    const there = options.cwd
      ? await this.inSandbox((container) => ['exec', container, 'test', '-d', options.cwd ?? '/'])
      : null

    await this.ensure()

    const child = Bun.spawn(
      [
        this.bin,
        'exec',
        '--interactive',
        '--tty',
        '--workdir',
        there?.exitCode === 0 && options.cwd ? options.cwd : '/workspace',
        '--env',
        'TERM=xterm-256color',
        '--env',
        'COLORTERM=truecolor',
        '--env',
        'LANG=C.UTF-8',
        this.container,
        'bash',
        '-l',
      ],
      {
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

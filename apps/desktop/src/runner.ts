import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { runnerStatusSchema, type RunnerStatus } from './channels'

/**
 * Keeps a `shuttle-runner` going beside the app: the process that holds this machine's sandbox
 * and connects it to Shuttle (see `apps/runner`).
 *
 * The runner is a program of its own so the sandbox work stays out of the app's main process,
 * and so it can be a single compiled binary in a packaged app. Its settings, the sign-in among
 * them, go to it on stdin; what it says on stdout is its status, one JSON object per line.
 */

export interface RunnerSettings {
  readonly url: string
  /** This machine's token. See `machine.ts`. */
  readonly token: string
  readonly deviceName: string
  readonly image?: string
  readonly buildContext?: string
}

const RESTART_MIN_MS = 2000
const RESTART_MAX_MS = 30_000

/** The runner as a packaged app ships it, or run from this repository with Bun. */
function runnerCommand(resourcesPath: string, repoRoot: string | null): string[] | null {
  const packaged = join(resourcesPath, 'shuttle-runner')

  if (existsSync(packaged)) {
    return [packaged, '--stdin']
  }

  const source = repoRoot === null ? null : join(repoRoot, 'apps/runner/src/main.ts')

  return source !== null && existsSync(source)
    ? [process.env.SHUTTLE_BUN ?? 'bun', source, '--stdin']
    : null
}

export class RunnerSupervisor {
  private child: ChildProcess | null = null
  private last: RunnerStatus = { status: 'starting' }
  private restart: ReturnType<typeof setTimeout> | null = null
  private delay = RESTART_MIN_MS
  private stopped = false

  constructor(
    private readonly options: {
      readonly resourcesPath: string
      readonly repoRoot: string | null
      /** Asked every time the runner starts. Null while nobody is signed in. */
      readonly settings: () => Promise<RunnerSettings | null>
      readonly changed: (status: RunnerStatus) => void
      /** The runner's token was turned away: the machine was removed from Shuttle. */
      readonly rejected: () => void
    },
  ) {}

  status(): RunnerStatus {
    return this.last
  }

  private report(status: RunnerStatus): void {
    this.last = status
    this.options.changed(status)
  }

  /** Starts the runner, or restarts it with fresh settings (after signing in, say). */
  async start(): Promise<void> {
    this.stopped = false
    this.kill()

    const command = runnerCommand(this.options.resourcesPath, this.options.repoRoot)

    if (!command) {
      this.report({ status: 'error', message: 'This build has no local sandbox runner.' })

      return
    }

    const settings = await this.options.settings()

    if (!settings) {
      this.report({ status: 'unauthorized', message: 'Sign in to use this machine as a sandbox.' })

      return
    }

    const [bin = '', ...args] = command

    const child = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'inherit'],
      // Finder starts apps with a bare PATH. Container engines and Bun usually live in these.
      env: {
        ...process.env,
        PATH: [
          process.env.PATH,
          '/usr/local/bin',
          '/opt/homebrew/bin',
          `${process.env.HOME}/.bun/bin`,
        ]
          .filter(Boolean)
          .join(':'),
      },
    })

    this.child = child
    this.report({ status: 'starting' })

    // Kept open: the runner stops when this pipe closes, so it never outlives the app.
    child.stdin.write(`${JSON.stringify(settings)}\n`)

    createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        this.report(runnerStatusSchema.parse(JSON.parse(line)))

        if (this.last.status === 'online') {
          this.delay = RESTART_MIN_MS
        }
      } catch {
        // Not a status line.
      }
    })

    child.on('error', (cause) => {
      this.report({
        status: 'error',
        message: `Could not start the sandbox runner: ${cause.message}`,
      })
    })

    child.on('exit', (code) => {
      if (this.child !== child || this.stopped) {
        return
      }

      this.child = null

      // It said why before it left. Signing in, or reconnecting from the menu, starts it again.
      if (code === 3) {
        this.options.rejected()

        return
      }

      if (this.last.status !== 'error') {
        this.report({ status: 'offline', message: 'The sandbox runner stopped.' })
      }

      this.restart = setTimeout(() => void this.start(), this.delay)
      this.delay = Math.min(this.delay * 2, RESTART_MAX_MS)
    })
  }

  private spawn(command: readonly string[]): ChildProcess {
    const [bin = '', ...args] = command

    return spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'inherit'],
      // Finder starts apps with a bare PATH. Container engines and Bun usually live in these.
      env: {
        ...process.env,
        PATH: [
          process.env.PATH,
          '/usr/local/bin',
          '/opt/homebrew/bin',
          `${process.env.HOME}/.bun/bin`,
        ]
          .filter(Boolean)
          .join(':'),
      },
    })
  }

  /**
   * Deletes this machine's sandbox, with the session files and agent sign-ins in it, then
   * starts a fresh one. Sessions that were working here keep what was last saved.
   */
  async reset(): Promise<void> {
    const running = this.child

    this.stop()

    // The sandbox has one runner at a time, so the old one has to be gone first.
    if (running && running.exitCode === null) {
      await new Promise((resolve) => running.once('exit', resolve))
    }

    const command = runnerCommand(this.options.resourcesPath, this.options.repoRoot)
    const settings = await this.options.settings()

    if (command && settings) {
      this.report({ status: 'preparing', message: 'Removing the local sandbox…' })

      const child = this.spawn([...command, '--remove'])

      child.stdin?.end(`${JSON.stringify(settings)}\n`)
      child.stdout?.resume()
      await new Promise((resolve) => child.on('exit', resolve).on('error', resolve))
    }

    await this.start()
  }

  private kill(): void {
    if (this.restart) {
      clearTimeout(this.restart)
      this.restart = null
    }

    const child = this.child

    this.child = null
    child?.stdin?.end()
    child?.kill()
  }

  stop(): void {
    this.stopped = true
    this.kill()
  }
}

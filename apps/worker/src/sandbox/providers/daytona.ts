import type { ShuttleEnv } from '../../env'
import { ContainerWorkspace } from '../container-workspace'
import {
  connectDaytonaSandbox,
  isDaytonaOwnError,
  openDaytonaTerminal,
  peekDaytonaSandbox,
  proxyDaytonaPreview,
  sandboxNotRunning,
} from '../daytona'
import { daytonaHost } from '../daytona-host'
import type { SandboxHost } from '../host'
import { orgOfSandbox } from '../names'
import { previewUnavailableResponse } from '../preview-proxy'
import type { Workspace } from '../workspace'
import type { SandboxMachine, SandboxProvider } from './types'

/** How long a Daytona sandbox is assumed to still be running before it is checked again. */
const DAYTONA_RECHECK_MS = 60_000

/** How long an answer to "is it running?" is reused. The Files tab asks every few seconds. */
const DAYTONA_PEEK_MS = 10_000

type DaytonaSandbox = Awaited<ReturnType<typeof connectDaytonaSandbox>>

/** A Daytona sandbox named after the Durable Object, which keeps its disk when it stops. */
class DaytonaMachine implements SandboxMachine {
  readonly kind = 'container'

  private known: { sandbox: DaytonaSandbox; checkedAt: number } | null = null
  private connecting: Promise<DaytonaSandbox> | null = null
  private peeked: { awake: boolean; at: number } | null = null
  private containerWs: ContainerWorkspace | null = null

  constructor(
    private readonly env: ShuttleEnv,
    private readonly name: string,
  ) {}

  /** The sandbox, started if it had stopped. Checked once a minute. */
  private async sandbox(): Promise<DaytonaSandbox> {
    const known = this.known

    if (known && Date.now() - known.checkedAt < DAYTONA_RECHECK_MS) {
      return known.sandbox
    }

    // A page loading in the preview asks many times at once. They share one wake-up: Daytona
    // refuses a second start while the first is under way.
    this.connecting ??= connectDaytonaSandbox(this.env, this.name)
      .then((sandbox) => {
        this.known = { sandbox, checkedAt: Date.now() }

        return sandbox
      })
      .finally(() => {
        this.connecting = null
      })

    return this.connecting
  }

  /**
   * Runs `use` against the sandbox. If it turns out to have gone to sleep since it was last
   * checked, it is woken and `use` runs once more: Daytona turned the first attempt away before
   * it reached the sandbox, so nothing ran twice.
   */
  private async awake<T>(use: (sandbox: DaytonaSandbox) => Promise<T>): Promise<T> {
    try {
      return await use(await this.sandbox())
    } catch (cause) {
      if (!sandboxNotRunning(cause)) {
        throw cause
      }

      this.known = null

      return use(await this.sandbox())
    }
  }

  async host(): Promise<SandboxHost> {
    // Connected here so a sandbox that cannot start fails now, not on first use.
    await this.sandbox()

    // Every operation wakes the sandbox if it has gone to sleep.
    return daytonaHost({
      process: {
        executeCommand: (command, cwd, env, timeout) =>
          this.awake((sandbox) => sandbox.process.executeCommand(command, cwd, env, timeout)),
      },
      fs: {
        uploadFile: (file, remotePath) =>
          this.awake((sandbox) =>
            // The SDK's upload takes a Node Buffer.
            // oxlint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-call, typescript/no-unsafe-member-access -- SAFETY: check-types types Buffer.from(Uint8Array) as Buffer; oxlint's type-aware pass cannot resolve Node's Buffer in this package and reports it as any.
            sandbox.fs.uploadFile(Buffer.from(file), remotePath),
          ),
        downloadFile: (remotePath) => this.awake((sandbox) => sandbox.fs.downloadFile(remotePath)),
      },
    })
  }

  async workspace(): Promise<Workspace> {
    this.containerWs ??= new ContainerWorkspace(
      () => this.host(),
      this.env,
      orgOfSandbox(this.name),
    )

    return this.containerWs
  }

  /** Asking never starts the sandbox. */
  async isAwake(): Promise<boolean> {
    const known = this.peeked

    if (known && Date.now() - known.at < DAYTONA_PEEK_MS) {
      return known.awake
    }

    const awake = (await peekDaytonaSandbox(this.env, this.name)) === 'started'

    this.peeked = { awake, at: Date.now() }

    return awake
  }

  terminal(request: Request): Promise<Response> {
    return this.awake((sandbox) => openDaytonaTerminal(request, sandbox))
  }

  /** A preview request, sent again after waking the sandbox if it had gone to sleep. */
  async preview(request: Request, port: number): Promise<Response> {
    // Split in case the request has to be sent twice; a body can only be read once.
    const [body, again] = request.body === null ? [null, null] : request.body.tee()
    const response = await proxyDaytonaPreview(request, await this.sandbox(), port, body)

    // Daytona answers for a sleeping sandbox with a 400 of its own, in JSON.
    if (
      response.status !== 400 ||
      response.headers.get('content-type')?.includes('json') !== true ||
      !sandboxNotRunning(await response.clone().text())
    ) {
      void again?.cancel().catch(() => {})

      return this.answer(request, port, response)
    }

    this.known = null

    return this.answer(
      request,
      port,
      await proxyDaytonaPreview(request, await this.sandbox(), port, again),
    )
  }

  /** A preview response, with Daytona's own errors replaced by ours so they never reach a person. */
  private async answer(request: Request, port: number, response: Response): Promise<Response> {
    if (!(await isDaytonaOwnError(response))) {
      return response
    }

    void response.body?.cancel().catch(() => {})

    return previewUnavailableResponse(request, port)
  }
}

export const daytonaProvider: SandboxProvider = {
  id: 'daytona',
  location: 'cloud',
  open: ({ env, name }) => new DaytonaMachine(env, name),
}

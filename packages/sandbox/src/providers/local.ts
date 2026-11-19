import type { z } from 'zod'

import {
  RUNNER_CONNECT_PATH,
  RUNNER_PING,
  RUNNER_PONG,
  RUNNER_PROTOCOL,
  RUNNER_REMOVED,
  RUNNER_REPLACED,
  type RunnerInbound,
  type RunnerRequest,
  type RunnerResults,
} from '@shuttle/runner-protocol'

import { ContainerWorkspace } from '../container-workspace'
import type { SandboxEnv } from '../env'
import type { HostOutput, SandboxHost } from '../host'
import { orgOfSandbox } from '../names'
import { previewUnavailableResponse } from '../preview-proxy'
import { terminalInput } from '../terminal-input'
import { nonEmpty } from '../text'
import type { Workspace } from '../workspace'
import {
  base64,
  fromBase64,
  helloFrame,
  outboundFrame,
  resultSchemas,
  socketAttachment,
  type HelloFrame,
  type ResponseFrame,
} from './local-frames'
import type { SandboxMachine, SandboxMachineInfo, SandboxProvider } from './types'

/**
 * A sandbox on a person's own machine.
 *
 * The machine runs a Shuttle runner (the desktop app starts one), which dials out to this Durable
 * Object and keeps a WebSocket open. Everything the sandbox is asked to do travels down that
 * socket as a request and comes back as an answer (see `@shuttle/runner-protocol`). How the
 * runner keeps the sandbox apart from the rest of the machine (a container, a virtual machine)
 * is the runner's business; from here it is one more `SandboxHost`.
 *
 * The socket is hibernatable, so an idle sandbox costs nothing while its runner stays connected.
 */

/** Marks an error as "the machine is not connected", so a caller can fall back to saved work. */
export const SANDBOX_OFFLINE = 'sandbox-offline'

export function isSandboxOffline(cause: unknown): boolean {
  return (cause instanceof Error ? cause.message : String(cause)).includes(SANDBOX_OFFLINE)
}

const RUNNER_TAG = 'runner'
const HELLO_KEY = 'local:hello'

/** Longest a command may run, a little over the longest timeout a workspace asks for. */
const EXEC_TIMEOUT_MS = 700_000
const CALL_TIMEOUT_MS = 60_000

interface Pending {
  /** Hands over the runner's answer; the request that is waiting reads it. */
  readonly answer: (frame: ResponseFrame) => void
  readonly reject: (cause: Error) => void
  readonly started?: (pid: number) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/** The part of a Durable Object's state that a local sandbox uses. */
export interface LocalContext {
  setWebSocketAutoResponse: DurableObjectState['setWebSocketAutoResponse']
  getWebSockets: DurableObjectState['getWebSockets']
  acceptWebSocket: DurableObjectState['acceptWebSocket']
  /** Where the runner's hello is kept, so it is known again after the object hibernates. */
  readonly hello: {
    readonly read: () => Promise<HelloFrame | null>
    readonly write: (frame: HelloFrame) => Promise<void>
  }
}

class LocalMachine implements SandboxMachine {
  readonly kind = 'container'

  private readonly pending = new Map<string, Pending>()
  /** Browser sockets of open terminals, by terminal id. */
  private readonly terminals = new Map<string, WebSocket>()
  private containerWs: ContainerWorkspace | null = null

  constructor(
    private readonly ctx: LocalContext,
    private readonly env: SandboxEnv,
    private readonly name: string,
  ) {
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(RUNNER_PING, RUNNER_PONG))
  }

  /**
   * The runner's socket: the newest one that is open. After a reconnect the socket it replaced
   * is still listed while it finishes closing, and nothing sent to that one arrives.
   */
  private runner(): WebSocket | null {
    let newest: WebSocket | null = null
    let newestAt = -1

    for (const socket of this.ctx.getWebSockets(RUNNER_TAG)) {
      const attachment = socketAttachment.safeParse(socket.deserializeAttachment())
      const at = attachment.success ? attachment.data.at : 0

      if (socket.readyState === WebSocket.OPEN && at > newestAt) {
        newest = socket
        newestAt = at
      }
    }

    return newest
  }

  private offline(): Error {
    return new Error(
      `${SANDBOX_OFFLINE}: this session's files are on a machine that is not connected. Open Shuttle there, or move the session to the cloud.`,
    )
  }

  private send(frame: RunnerInbound): void {
    const runner = this.runner()

    if (runner === null) {
      throw this.offline()
    }

    runner.send(JSON.stringify(frame))
  }

  private call<Op extends RunnerRequest['op']>(
    request: Extract<RunnerRequest, { op: Op }>,
    options: { readonly timeoutMs?: number; readonly started?: (pid: number) => void } = {},
  ): Promise<RunnerResults[Op]> {
    const schema: z.ZodType<RunnerResults[Op]> = resultSchemas[request.op]
    const wire: RunnerRequest = request

    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID()

      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`The local sandbox did not answer ${request.op} in time`))
      }, options.timeoutMs ?? CALL_TIMEOUT_MS)

      this.pending.set(id, {
        answer: (frame) => {
          if (!frame.ok) {
            // Callers tell a missing file from other failures by this prefix.
            reject(new Error(frame.code === 'ENOENT' ? `ENOENT: ${frame.error}` : frame.error))

            return
          }

          const result = schema.safeParse(frame.result)

          if (result.success) {
            resolve(result.data)
          } else {
            reject(new Error(`The local sandbox answered ${request.op} in an unexpected shape`))
          }
        },
        reject,
        timer,
        started: options.started,
      })

      try {
        this.send({ type: 'req', id, ...wire })
      } catch (cause) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(cause instanceof Error ? cause : new Error(String(cause)))
      }
    })
  }

  async host(): Promise<SandboxHost> {
    if (!this.runner()) {
      throw this.offline()
    }

    return {
      exec: async (argv, options) => {
        const stdin =
          options?.stdin === undefined
            ? undefined
            : base64(await new Response(options.stdin).arrayBuffer())

        const { promise: started, resolve: announce } = Promise.withResolvers<number | undefined>()

        const output: Promise<HostOutput> = this.call(
          {
            op: 'exec',
            argv,
            cwd: nonEmpty(options?.cwd),
            env: options?.env,
            stdin: nonEmpty(stdin),
          },
          { timeoutMs: EXEC_TIMEOUT_MS, started: announce },
        ).then((result) => ({
          stdout: fromBase64(result.stdout),
          stderr: fromBase64(result.stderr),
          exitCode: result.exitCode,
        }))

        // A command that failed to start has no pid to wait for. Whoever reads the output
        // hears why.
        output.then(
          () => announce(undefined),
          () => announce(undefined),
        )

        const pid = await started

        return { pid, output: () => output }
      },
      readFile: async (path) =>
        new TextDecoder().decode(fromBase64((await this.call({ op: 'readBytes', path })).data)),
      writeFile: async (path, content) => {
        await this.call({ op: 'writeBytes', path, data: base64(new TextEncoder().encode(content)) })
      },
      readBytes: async (path) =>
        new Uint8Array(fromBase64((await this.call({ op: 'readBytes', path })).data)),
      writeBytes: async (path, content) => {
        await this.call({ op: 'writeBytes', path, data: base64(content) })
      },
      mkdir: async (path) => {
        await this.call({ op: 'mkdir', path })
      },
    }
  }

  async workspace(): Promise<Workspace> {
    this.containerWs ??= new ContainerWorkspace(
      () => this.host(),
      this.env,
      orgOfSandbox(this.name),
    )

    return this.containerWs
  }

  async isAwake(): Promise<boolean> {
    return this.runner() !== null
  }

  async describe(): Promise<SandboxMachineInfo> {
    const hello = (await this.ctx.hello.read()) ?? undefined

    return {
      online: this.runner() !== null,
      device:
        hello === undefined
          ? undefined
          : { id: hello.device.id, name: hello.device.name, platform: hello.device.platform },
      backend:
        hello === undefined
          ? undefined
          : {
              id: hello.backend.id,
              label: hello.backend.label,
              isolation: hello.backend.isolation,
            },
    }
  }

  async terminal(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return Response.json({ error: 'Expected WebSocket upgrade' }, { status: 426 })
    }

    if (this.runner() === null) {
      return Response.json({ error: this.offline().message }, { status: 503 })
    }

    const url = new URL(request.url)

    const size = (name: string, fallback: number) => {
      const value = Number(url.searchParams.get(name) ?? fallback)

      return Number.isFinite(value) && value > 0 ? value : fallback
    }

    const term = crypto.randomUUID()
    const cwd = url.searchParams.get('cwd')
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]

    server.accept()
    this.terminals.set(term, server)

    const close = () => {
      if (this.terminals.delete(term)) {
        try {
          this.send({ type: 'term.close', term })
        } catch {
          // The runner has gone, and the shell with it.
        }
      }
    }

    server.addEventListener('message', (event) => {
      const input = terminalInput(event)

      if (input === null) {
        return
      }

      try {
        switch (input.kind) {
          case 'resize':
            this.send({ type: 'term.resize', term, cols: input.cols, rows: input.rows })

            return
          case 'text':
            this.send({
              type: 'term.input',
              term,
              data: base64(new TextEncoder().encode(input.text)),
            })

            return
          case 'bytes':
            this.send({ type: 'term.input', term, data: base64(input.bytes) })

            return
        }
      } catch {
        server.close(1011, 'local sandbox disconnected')
      }
    })

    server.addEventListener('close', close)
    server.addEventListener('error', close)

    await this.call({
      op: 'term.open',
      term,
      cols: size('cols', 80),
      rows: size('rows', 24),
      cwd: nonEmpty(cwd),
    })

    return new Response(null, { status: 101, webSocket: client })
  }

  async preview(request: Request, port: number): Promise<Response> {
    if (!this.runner()) {
      return previewUnavailableResponse(
        request,
        port,
        'This preview runs on a machine that is not connected to Shuttle right now.',
      )
    }

    const url = new URL(request.url)
    const body = request.body === null ? undefined : base64(await request.arrayBuffer())

    try {
      const answer = await this.call({
        op: 'http',
        port,
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers: [...request.headers].filter(([name]) => name.toLowerCase() !== 'host'),
        body: nonEmpty(body),
      })

      const headers = new Headers()

      for (const [name, value] of answer.headers) {
        // The body arrives whole and decoded, so its original framing no longer describes it.
        if (!/^(content-length|content-encoding|transfer-encoding|connection)$/i.test(name)) {
          headers.append(name, value)
        }
      }

      const empty = answer.status === 204 || answer.status === 304 || request.method === 'HEAD'

      return new Response(empty ? null : fromBase64(answer.body), {
        status: answer.status,
        headers,
      })
    } catch (cause) {
      return previewUnavailableResponse(
        request,
        port,
        cause instanceof Error ? cause.message : String(cause),
      )
    }
  }

  async disconnect(): Promise<void> {
    for (const socket of this.ctx.getWebSockets(RUNNER_TAG)) {
      socket.close(RUNNER_REMOVED, 'this machine was removed from Shuttle')
    }
  }

  /** A runner connecting. The Worker has already checked whose machine it is. */
  async fetch(request: Request): Promise<Response | null> {
    if (new URL(request.url).pathname !== RUNNER_CONNECT_PATH) {
      return null
    }

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return Response.json({ error: 'Expected WebSocket upgrade' }, { status: 426 })
    }

    // One runner holds a sandbox. A reconnect takes over from the socket it lost.
    for (const old of this.ctx.getWebSockets(RUNNER_TAG)) {
      old.close(RUNNER_REPLACED, 'replaced by a newer connection')
    }

    const pair = new WebSocketPair()

    this.ctx.acceptWebSocket(pair[1], [RUNNER_TAG])
    pair[1].serializeAttachment({ at: Date.now() })

    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message instanceof ArrayBuffer) {
      return
    }

    let parsed: ReturnType<typeof outboundFrame.safeParse>

    try {
      parsed = outboundFrame.safeParse(JSON.parse(message))
    } catch {
      return
    }

    if (!parsed.success) {
      return
    }

    const frame = parsed.data

    switch (frame.type) {
      case 'hello':
        if (frame.protocol !== RUNNER_PROTOCOL) {
          socket.close(1002, `protocol ${RUNNER_PROTOCOL} required`)

          return
        }

        await this.ctx.hello.write(frame)

        return
      case 'started':
        this.pending.get(frame.id)?.started?.(frame.pid)

        return

      case 'res': {
        const waiting = this.pending.get(frame.id)

        if (!waiting) {
          return
        }

        clearTimeout(waiting.timer)
        this.pending.delete(frame.id)
        waiting.answer(frame)

        return
      }

      case 'term.data':
        try {
          this.terminals.get(frame.term)?.send(fromBase64(frame.data))
        } catch {
          // The browser went away; its close handler ends the shell.
        }

        return

      case 'term.exit': {
        const terminal = this.terminals.get(frame.term)

        this.terminals.delete(frame.term)

        try {
          terminal?.close(1000, 'process exited')
        } catch {
          // Already closed.
        }

        return
      }

      default:
    }
  }

  async webSocketClose(): Promise<void> {
    // A socket that was replaced closes after its successor connected. Nothing is lost then.
    if (this.runner() !== null) {
      return
    }

    for (const [id, waiting] of this.pending) {
      clearTimeout(waiting.timer)
      waiting.reject(this.offline())
      this.pending.delete(id)
    }

    for (const [term, terminal] of this.terminals) {
      this.terminals.delete(term)

      try {
        terminal.close(1001, 'local sandbox disconnected')
      } catch {
        // Already closed.
      }
    }
  }
}

/** A sandbox on a person's own machine, for a Durable Object (or a test double of one). */
export function openLocalMachine(ctx: LocalContext, env: SandboxEnv, name: string): SandboxMachine {
  return new LocalMachine(ctx, env, name)
}

export const localProvider: SandboxProvider = {
  id: 'local',
  location: 'local',
  open: ({ ctx, env, name }) =>
    openLocalMachine(
      {
        setWebSocketAutoResponse: (pair) => ctx.setWebSocketAutoResponse(pair),
        getWebSockets: (tag) => ctx.getWebSockets(tag),
        acceptWebSocket: (socket, tags) => ctx.acceptWebSocket(socket, tags),
        hello: {
          read: async () => {
            const stored = helloFrame.safeParse(await ctx.storage.get(HELLO_KEY))

            return stored.success ? stored.data : null
          },
          write: (frame) => ctx.storage.put(HELLO_KEY, frame),
        },
      },
      env,
      name,
    ),
}

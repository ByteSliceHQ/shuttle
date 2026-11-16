import {
  RUNNER_CONNECT_PATH,
  RUNNER_PING,
  RUNNER_PROTOCOL,
  RUNNER_REMOVED,
  RUNNER_REPLACED,
  type RunnerDevice,
  type RunnerInbound,
  type RunnerOutbound,
  type RunnerRequest,
} from '@shuttle/runner-protocol'

import { MissingFileError, type LocalBackend, type LocalTerminal } from './backend'

/**
 * The runner's connection to Shuttle: one WebSocket to this machine's sandbox Durable Object,
 * dialled from here and redialled whenever it drops. Requests arrive on it and are answered by
 * the backend.
 */

const PING_MS = 20_000
const RETRY_MIN_MS = 1000
const RETRY_MAX_MS = 15_000

/** How long to stand back after being replaced, so two runners do not take turns forever. */
const REPLACED_RETRY_MS = 60_000

export type LinkStatus = 'connecting' | 'online' | 'offline'

export interface LinkOptions {
  /** Shuttle's address, such as `https://shuttle.example` or `http://127.0.0.1:8790`. */
  readonly url: string
  /** This machine's token. The runner connects as the person it was registered by. */
  readonly token: string
  readonly device: RunnerDevice
  readonly backend: LocalBackend
  readonly status: (status: LinkStatus, detail?: string) => void
  /** Called when Shuttle no longer knows this machine. The link does not try again. */
  readonly removed: () => void
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

function fromBase64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64'))
}

async function answer(
  backend: LocalBackend,
  request: RunnerRequest,
  started: (pid: number) => void,
  terminal: (term: string, cwd: string | undefined, cols: number, rows: number) => Promise<void>,
): Promise<unknown> {
  switch (request.op) {
    case 'exec': {
      const output = await backend.exec(request.argv, {
        started,
        ...(request.cwd ? { cwd: request.cwd } : {}),
        ...(request.env ? { env: request.env } : {}),
        ...(request.stdin ? { stdin: fromBase64(request.stdin) } : {}),
      })

      return {
        stdout: base64(output.stdout),
        stderr: base64(output.stderr),
        exitCode: output.exitCode,
      }
    }

    case 'readBytes':
      return { data: base64(await backend.readBytes(request.path)) }
    case 'writeBytes':
      await backend.writeBytes(request.path, fromBase64(request.data))

      return {}
    case 'mkdir':
      await backend.mkdir(request.path)

      return {}
    case 'http':
      return backend.http(request)
    case 'term.open':
      await terminal(request.term, request.cwd, request.cols, request.rows)

      return {}

    default: {
      const unknown: never = request

      throw new Error(`unknown request ${JSON.stringify(unknown)}`)
    }
  }
}

export function connect(options: LinkOptions): { close(): void } {
  const { backend, device } = options
  const terminals = new Map<string, LocalTerminal>()
  let socket: WebSocket | null = null
  let closed = false
  let retry = RETRY_MIN_MS
  let ping: ReturnType<typeof setInterval> | null = null

  const target = new URL(RUNNER_CONNECT_PATH, options.url)

  target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
  target.searchParams.set('device', device.id)

  const send = (frame: RunnerOutbound) => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(frame))
    }
  }

  const openTerminal = async (
    term: string,
    cwd: string | undefined,
    cols: number,
    rows: number,
  ) => {
    terminals.set(
      term,
      await backend.openTerminal({
        cols,
        rows,
        ...(cwd ? { cwd } : {}),
        data: (bytes) => send({ type: 'term.data', term, data: base64(bytes) }),
        exit: () => {
          terminals.delete(term)
          send({ type: 'term.exit', term })
        },
      }),
    )
  }

  const handle = (frame: RunnerInbound) => {
    switch (frame.type) {
      case 'req': {
        const { id } = frame

        answer(backend, frame, (pid) => send({ type: 'started', id, pid }), openTerminal).then(
          (result) => send({ type: 'res', id, ok: true, result }),
          (cause: unknown) =>
            send({
              type: 'res',
              id,
              ok: false,
              error: cause instanceof Error ? cause.message : String(cause),
              ...(cause instanceof MissingFileError ? { code: cause.code } : {}),
            }),
        )

        return
      }

      case 'term.input':
        terminals.get(frame.term)?.write(fromBase64(frame.data))

        return
      case 'term.resize':
        terminals.get(frame.term)?.resize(frame.cols, frame.rows)

        return
      case 'term.close':
        terminals.get(frame.term)?.close()
        terminals.delete(frame.term)

        return
      default:
    }
  }

  const dial = () => {
    if (closed) {
      return
    }

    options.status('connecting')

    // Bun's WebSocket takes request headers, which is how the runner signs in.
    const next = new WebSocket(target.toString(), {
      headers: { authorization: `Bearer ${options.token}` },
    } as unknown as string[])

    socket = next

    next.addEventListener('open', () => {
      retry = RETRY_MIN_MS
      send({ type: 'hello', protocol: RUNNER_PROTOCOL, device, backend: backend.info })
      ping = setInterval(() => next.send(RUNNER_PING), PING_MS)
      options.status('online')
    })

    next.addEventListener('message', (event) => {
      if (typeof event.data !== 'string' || !event.data.startsWith('{')) {
        return
      }

      try {
        handle(JSON.parse(event.data) as RunnerInbound)
      } catch {
        // A frame this runner does not understand. A newer Shuttle may send them.
      }
    })

    next.addEventListener('close', (event) => {
      if (ping) {
        clearInterval(ping)
        ping = null
      }

      for (const [term, terminal] of terminals) {
        terminal.close()
        terminals.delete(term)
      }

      if (socket !== next || closed) {
        return
      }

      if (event.code === RUNNER_REMOVED) {
        closed = true
        options.removed()

        return
      }

      if (event.code === RUNNER_REPLACED) {
        options.status('offline', 'Another Shuttle on this machine is running its sandbox.')
        setTimeout(dial, REPLACED_RETRY_MS)

        return
      }

      options.status('offline', event.reason || `connection closed (${event.code})`)
      setTimeout(dial, retry)
      retry = Math.min(retry * 2, RETRY_MAX_MS)
    })
  }

  dial()

  return {
    close() {
      closed = true
      socket?.close(1000, 'runner stopped')
    },
  }
}

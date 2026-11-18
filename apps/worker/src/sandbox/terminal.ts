import { ensureContainerRunning, type DurableContainer } from './container-runtime'
import { terminalInput } from './terminal-input'
import { nonEmpty } from './text'

/** Sends everything the stream produces to the browser until the stream or the socket ends. */
function forward(stream: ReadableStream, server: WebSocket): Promise<void> {
  const sink = new WritableStream<Uint8Array>({
    write(chunk) {
      server.send(chunk)
    },
  })

  // Socket or stream closed: nothing more to send.
  return stream.pipeTo(sink, { preventCancel: true }).catch(() => {})
}

/** Upgrade an HTTP request into a container PTY WebSocket. */
export async function openContainerTerminal(
  request: Request,
  container: DurableContainer,
): Promise<Response> {
  const upgrade = request.headers.get('Upgrade')

  if (upgrade?.toLowerCase() !== 'websocket') {
    return Response.json({ error: 'Expected WebSocket upgrade' }, { status: 426 })
  }

  const running = await ensureContainerRunning(container)
  const url = new URL(request.url)
  const cwd = nonEmpty(url.searchParams.get('cwd')) ?? '/workspace'
  const cols = Number(url.searchParams.get('cols') ?? 80)
  const rows = Number(url.searchParams.get('rows') ?? 24)

  const pair = new WebSocketPair()
  const client = pair[0]
  const server = pair[1]
  server.accept()

  const process = await running.exec(['bash', '-l'], {
    cwd,
    pty: {
      cols: Number.isFinite(cols) && cols > 0 ? cols : 80,
      rows: Number.isFinite(rows) && rows > 0 ? rows : 24,
    },
    stdin: 'pipe',
  })

  const stdout = process.stdout
  const stderr = process.stderr
  const stdin = process.stdin

  if (stdout) {
    void forward(stdout, server).finally(() => {
      try {
        server.close(1000, 'process exited')
      } catch {
        // Already closed.
      }
    })
  }

  if (stderr) {
    void forward(stderr, server)
  }

  const writer = stdin?.getWriter()

  server.addEventListener('message', (event: MessageEvent) => {
    void (async () => {
      try {
        const input = terminalInput(event)

        if (input === null) {
          return
        }

        switch (input.kind) {
          case 'resize':
            process.resize(input.cols, input.rows)
            return
          case 'text':
            await writer?.write(new TextEncoder().encode(input.text))
            return
          case 'bytes':
            await writer?.write(input.bytes)
            return
        }
      } catch {
        // Ignore write failures after close.
      }
    })()
  })

  const shutdown = () => {
    try {
      process.kill()
    } catch {
      // Already dead.
    }

    try {
      void writer?.close()
    } catch {
      // Already closed.
    }
  }

  server.addEventListener('close', shutdown)
  server.addEventListener('error', shutdown)

  return new Response(null, { status: 101, webSocket: client })
}

import { ensureContainerRunning, type DurableContainer } from './container-runtime'

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
  const cwd = url.searchParams.get('cwd') || '/workspace'
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
  const stdin = process.stdin

  if (stdout) {
    void (async () => {
      const reader = stdout.getReader()

      try {
        for (;;) {
          const { done, value } = await reader.read()

          if (done) {
            break
          }

          if (value) {
            server.send(value)
          }
        }
      } catch {
        // Socket or stream closed.
      } finally {
        try {
          server.close(1000, 'process exited')
        } catch {
          // Already closed.
        }
      }
    })()
  }

  if (process.stderr) {
    void (async () => {
      const reader = process.stderr!.getReader()

      try {
        for (;;) {
          const { done, value } = await reader.read()

          if (done) {
            break
          }

          if (value) {
            server.send(value)
          }
        }
      } catch {
        // Closed.
      }
    })()
  }

  const writer = stdin?.getWriter()

  server.addEventListener('message', (event: MessageEvent) => {
    void (async () => {
      try {
        if (typeof event.data === 'string') {
          if (event.data.startsWith('{')) {
            const message = JSON.parse(event.data) as {
              type?: string
              cols?: number
              rows?: number
            }

            if (
              message.type === 'resize' &&
              typeof message.cols === 'number' &&
              typeof message.rows === 'number'
            ) {
              process.resize(message.cols, message.rows)
              return
            }
          }

          await writer?.write(new TextEncoder().encode(event.data))
          return
        }

        if (event.data instanceof ArrayBuffer) {
          await writer?.write(new Uint8Array(event.data))
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

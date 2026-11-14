import { existsSync, unlinkSync } from 'node:fs'
import { connect, createServer, type Socket } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import type { LspRequest, LspStatusReply } from './protocol.ts'
import { ServerPool } from './servers.ts'

/**
 * shuttle-lsp daemon: keeps language servers warm between tool calls. One per sandbox, started
 * by the first `cli.ts` call that finds none, listening on a unix socket.
 *
 * Each connection sends one JSON request on a line and gets one JSON reply on a line.
 */

/** With nothing asked for this long, the daemon and its servers exit. The next call restarts them. */
const IDLE_EXIT_MS = 20 * 60 * 1000

export function socketPath(): string {
  return process.env.SHUTTLE_LSP_SOCKET ?? join(tmpdir(), `shuttle-lsp-${userInfo().uid}.sock`)
}

function isLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(path)

    probe.once('connect', () => {
      probe.destroy()
      resolve(true)
    })

    probe.once('error', () => resolve(false))
  })
}

export async function runDaemon(): Promise<void> {
  const path = socketPath()

  if (existsSync(path)) {
    if (await isLive(path)) {
      // Another daemon won the race to start. It serves everyone.
      return
    }

    unlinkSync(path)
  }

  const pool = new ServerPool()
  let idle: ReturnType<typeof setTimeout>

  const shutdown = () => {
    pool.stop()
    server.close()

    try {
      unlinkSync(path)
    } catch {
      // Already gone.
    }

    process.exit(0)
  }

  const touch = () => {
    clearTimeout(idle)
    idle = setTimeout(shutdown, IDLE_EXIT_MS)
  }

  const answer = async (request: LspRequest): Promise<unknown> => {
    if (request.op === 'diagnostics') {
      return await pool.diagnostics(request.file, request.waitMs, request.text)
    }

    if (request.op === 'status') {
      return { status: 'ok', pid: process.pid, servers: pool.status() } satisfies LspStatusReply
    }

    if (request.op === 'stop') {
      setImmediate(shutdown)
      return { status: 'ok' }
    }

    return { status: 'error', reason: 'unknown request' }
  }

  const server = createServer((socket: Socket) => {
    socket.on('error', () => {})

    createInterface({ input: socket }).once('line', (line) => {
      touch()

      void (async () => {
        let reply: unknown

        try {
          reply = await answer(JSON.parse(line) as LspRequest)
        } catch (cause) {
          reply = {
            status: 'error',
            reason: cause instanceof Error ? cause.message : String(cause),
          }
        }

        socket.end(`${JSON.stringify(reply)}\n`)
      })()
    })
  })

  server.listen(path)
  touch()

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void runDaemon()
}

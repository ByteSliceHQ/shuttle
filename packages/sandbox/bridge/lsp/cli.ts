import { spawn } from 'node:child_process'
import { openSync, readFileSync, unlinkSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { socketPath } from './daemon'
import { LSP_DEFAULT_WAIT_MS, type LspRequest } from './protocol'

/**
 * shuttle-lsp: asks the sandbox's language servers about a file.
 *
 *   node cli.ts diagnostics <file> [--wait-ms 8000] [--text-file <path>]
 *   node cli.ts status
 *   node cli.ts stop
 *
 * `--text-file` names a file holding an unsaved edit of `<file>` to check in place of what is on
 * disk. It is read once and deleted.
 *
 * Prints one JSON reply. Starts the daemon that holds the servers when none is running, so the
 * first call in a sandbox pays for the start and later ones do not.
 */

/** How long to wait for a daemon this call just started to begin listening. */
const DAEMON_START_MS = 5000

function send(request: LspRequest): Promise<string> {
  return new Promise((resolveReply, reject) => {
    const socket = connect(socketPath())
    let reply = ''

    socket.setEncoding('utf8')
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`))

    socket.on('data', (chunk: string) => {
      reply += chunk
    })

    socket.once('end', () => resolveReply(reply.trim()))
    socket.once('error', reject)
  })
}

function startDaemon(): void {
  const log = openSync(join(tmpdir(), 'shuttle-lsp.log'), 'a')
  const daemon = fileURLToPath(new URL('./daemon.ts', import.meta.url))

  spawn(process.execPath, [daemon], { detached: true, stdio: ['ignore', log, log] }).unref()
}

async function ask(request: LspRequest): Promise<string> {
  try {
    return await send(request)
  } catch {
    // No daemon yet, or a stale socket from one that died.
  }

  if (request.op === 'stop') {
    return JSON.stringify({ status: 'ok' })
  }

  startDaemon()

  const deadline = Date.now() + DAEMON_START_MS

  for (;;) {
    await new Promise((wake) => setTimeout(wake, 100))

    try {
      return await send(request)
    } catch (cause) {
      if (Date.now() > deadline) {
        throw cause
      }
    }
  }
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main(): Promise<void> {
  const [op, file] = process.argv.slice(2)
  let request: LspRequest

  if (op === 'diagnostics' && file) {
    const waitMs = Number(option('wait-ms') ?? LSP_DEFAULT_WAIT_MS)

    const textFile = option('text-file')
    let text: string | undefined

    if (textFile) {
      text = readFileSync(textFile, 'utf8')
      unlinkSync(textFile)
    }

    request = {
      op,
      file: resolve(file),
      waitMs: Number.isFinite(waitMs) && waitMs > 0 ? waitMs : LSP_DEFAULT_WAIT_MS,
      text,
    }
  } else if (op === 'status' || op === 'stop') {
    request = { op }
  } else {
    process.stderr.write(
      'usage: shuttle-lsp diagnostics <file> [--wait-ms N] [--text-file PATH] | status | stop\n',
    )

    process.exitCode = 2
    return
  }

  try {
    process.stdout.write(`${await ask(request)}\n`)
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    process.stdout.write(`${JSON.stringify({ status: 'error', reason })}\n`)
    process.exitCode = 1
  }
}

void main()

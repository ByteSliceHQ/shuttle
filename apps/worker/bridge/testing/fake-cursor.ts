#!/usr/bin/env bun
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * A stand-in for the Cursor Agent CLI that prints just enough of its output for the bridge tests.
 * FAKE_CURSOR_MODE picks the behaviour: `turn` (default), `hang`, `unauthenticated`, `reject-login`,
 * `echo-prompt` (replies with the prompt it was given), and `background-shell` (leaves a shell
 * running, so it only finishes when told how long to wait for it).
 */

const mode = process.env.FAKE_CURSOR_MODE ?? 'turn'
const args = process.argv.slice(2)
const print = (line: unknown) => process.stdout.write(`${JSON.stringify(line)}\n`)
const signedInMarker = join(homedir(), '.fake-cursor-signed-in')
const authFile = join(homedir(), '.config', 'cursor', 'auth.json')

function markSignedIn() {
  mkdirSync(join(homedir(), '.config', 'cursor'), { recursive: true })
  writeFileSync(authFile, JSON.stringify({ accessToken: 'fake' }))
  writeFileSync(signedInMarker, 'yes')
}

if (args[0] === 'status') {
  const signedIn = existsSync(signedInMarker)

  print(
    signedIn
      ? {
          status: 'authenticated',
          isAuthenticated: true,
          userInfo: { email: 'dev@example.test', userId: 1 },
        }
      : { status: 'unauthenticated', isAuthenticated: false },
  )

  process.exit(0)
}

if (args[0] === 'models') {
  print({
    models: [
      { id: 'composer-2.5', label: 'Composer 2.5', isDefault: true },
      { id: 'auto', label: 'Auto' },
    ],
  })

  process.exit(0)
}

if (args.includes('--list-models')) {
  process.stdout.write('composer-2.5 - Composer 2.5\nauto - Auto\n')
  process.exit(0)
}

if (args[0] === 'login') {
  process.stdout.write('Visit https://example.test/cursor-login?state=xyz to authenticate.\n')

  if (mode === 'reject-login') {
    process.stdout.write('Login failed\n')
    process.exit(1)
  }

  if (mode === 'hang') {
    process.on('SIGTERM', () => process.exit(143))
    process.on('SIGINT', () => process.exit(130))
    setInterval(() => {}, 1_000)
  } else {
    process.stdout.write('Authentication tokens stored securely.\n')
    markSignedIn()
    process.exit(0)
  }
} else {
  const resume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : undefined

  if (resume === 'lost') {
    process.stderr.write('No conversation found with session ID: lost\n')
    process.exit(1)
  }

  const session = resume ?? 'sess_new'

  print({
    type: 'system',
    subtype: 'init',
    session_id: session,
    model: 'composer-test',
    apiKeySource: 'login',
  })

  if (mode === 'unauthenticated') {
    print({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: 'Not authenticated. Run `agent login`.',
      session_id: session,
    })

    process.exit(1)
  }

  if (mode === 'echo-prompt') {
    print({ type: 'result', subtype: 'success', is_error: false, result: args.at(-1) })
  } else if (mode === 'background-shell') {
    print({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Server is up on 5173.' }] },
      session_id: session,
    })

    const timeout = args.includes('--background-shell-timeout')
      ? Number(args[args.indexOf('--background-shell-timeout') + 1])
      : undefined

    // The real CLI waits for its background shells before it reports a result.
    if (timeout === undefined) {
      process.on('SIGINT', () => process.exit(130))
      setInterval(() => {}, 1_000)
    } else {
      print({ type: 'system', subtype: 'background_shell_timeout', aborted_count: 1 })
      print({ type: 'result', subtype: 'success', is_error: false, result: 'Server is up.' })
    }
  } else if (mode === 'hang') {
    process.on('SIGINT', () => process.exit(130))
    setInterval(() => {}, 1_000)
  } else {
    print({
      type: 'assistant',
      timestamp_ms: 1,
      message: { content: [{ type: 'text', text: 'Looking' }] },
      session_id: session,
    })

    print({
      type: 'assistant',
      timestamp_ms: 2,
      message: { content: [{ type: 'text', text: '…' }] },
      session_id: session,
    })

    print({
      type: 'tool_call',
      subtype: 'started',
      call_id: 'call_1',
      tool_call: { readToolCall: { args: { path: 'README.md' } } },
      session_id: session,
    })

    // Buffered flush before a tool call — duplicate text, must be skipped.
    print({
      type: 'assistant',
      timestamp_ms: 3,
      model_call_id: 'mc_1',
      message: { content: [{ type: 'text', text: 'Looking…' }] },
      session_id: session,
    })

    print({
      type: 'tool_call',
      subtype: 'completed',
      call_id: 'call_1',
      tool_call: {
        readToolCall: {
          args: { path: 'README.md' },
          result: { success: { totalLines: 12, content: '# Project' } },
        },
      },
      session_id: session,
    })

    print({
      type: 'tool_call',
      subtype: 'started',
      call_id: 'call_2',
      tool_call: { writeToolCall: { args: { path: 'summary.txt' } } },
      session_id: session,
    })

    print({
      type: 'tool_call',
      subtype: 'completed',
      call_id: 'call_2',
      tool_call: {
        writeToolCall: {
          args: { path: 'summary.txt' },
          result: { success: { linesCreated: 3, path: '/tmp/summary.txt' } },
        },
      },
      session_id: session,
    })

    print({
      type: 'assistant',
      timestamp_ms: 4,
      message: { content: [{ type: 'text', text: 'Done.' }] },
      session_id: session,
    })

    // Final flush at end of turn — duplicate, mapped as message only when no timestamp.
    print({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Done.' }] },
      session_id: session,
    })

    print({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Looking…Done.',
      session_id: session,
    })
  }
}

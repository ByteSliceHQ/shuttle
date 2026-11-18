#!/usr/bin/env bun
import { existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import type { JsonValue } from '../json.ts'

/**
 * A stand-in for the Claude Code CLI that prints just enough of its output for the bridge tests.
 * FAKE_CLAUDE_MODE picks the behaviour: `turn` (default), `hang`, `unauthenticated`.
 */

const mode = process.env.FAKE_CLAUDE_MODE ?? 'turn'
const args = process.argv.slice(2)
const print = (line: JsonValue) => process.stdout.write(`${JSON.stringify(line)}\n`)
const signedInMarker = join(homedir(), '.fake-claude-signed-in')

if (args[0] === 'auth' && args[1] === 'status') {
  print({ loggedIn: existsSync(signedInMarker) })
  process.exit(0)
}

if (args[0] === 'auth' && args[1] === 'login') {
  process.stdout.write('Opening browser to sign in…\n')
  process.stdout.write("If the browser didn't open, visit: https://example.test/oauth?state=abc\n")
  process.stdout.write('Paste code here if prompted > ')

  createInterface({ input: process.stdin }).once('line', (code) => {
    if (code === 'good-code') {
      writeFileSync(signedInMarker, 'yes')
      process.exit(0)
    }

    process.stdout.write('\nInvalid code\n')
    process.exit(1)
  })
} else {
  const resume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : undefined

  if (resume === 'lost') {
    process.stderr.write('No conversation found with session ID: lost\n')
    process.exit(1)
  }

  const session = resume ?? 'sess_new'

  print({ type: 'system', subtype: 'init', session_id: session, model: 'claude-test' })

  if (mode === 'unauthenticated') {
    print({
      type: 'assistant',
      error: 'authentication_failed',
      message: { content: [{ type: 'text', text: 'Not logged in · Please run /login' }] },
    })

    print({ type: 'result', is_error: true, result: 'Not logged in · Please run /login' })
    process.exit(0)
  }

  if (mode === 'hang') {
    process.on('SIGINT', () => process.exit(130))
    setInterval(() => {}, 1_000)
  } else {
    const delta = (inner: JsonValue) =>
      print({ type: 'stream_event', event: { type: 'content_block_delta', delta: inner } })

    delta({ type: 'thinking_delta', thinking: 'Look at the file.' })

    print({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'Look at the file.' },
          { type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: 'ls' } },
          { type: 'tool_use', id: 'tool_2', name: 'Edit', input: { file_path: 'src/a.ts' } },
        ],
      },
    })

    print({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tool_1', content: 'a.ts' },
          {
            type: 'tool_result',
            tool_use_id: 'tool_2',
            is_error: true,
            content: [{ type: 'text', text: 'no match' }],
          },
        ],
      },
    })

    // Output from a subagent must not be shown as the agent's own text.
    print({
      type: 'assistant',
      parent_tool_use_id: 'tool_9',
      message: { content: [{ type: 'text', text: 'subagent chatter' }] },
    })

    delta({ type: 'text_delta', text: 'Done.' })

    print({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Done.' }],
        usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 },
      },
    })

    print({ type: 'result', is_error: false, result: 'Done.', session_id: session })
  }
}

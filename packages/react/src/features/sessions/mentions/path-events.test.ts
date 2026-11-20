import { describe, expect, test } from 'bun:test'

import type { JsonValue } from '@swirls/looms/core'

import { commandKeepsPaths, readPathEvents, type LoggedEvent } from './path-events'

const RUN = 'o-orgA-session_1'
const ROOT = `/workspace/.wt/${RUN}`

let seq = 0

function call(name: string, args: Record<string, JsonValue>, error?: string): LoggedEvent[] {
  seq += 2
  const id = `call_${seq}`

  const requested: LoggedEvent = {
    type: 'agent.tool_call.requested',
    seq: seq - 1,
    payload: { toolCall: { id, name, arguments: args } },
  }

  const result: LoggedEvent =
    error === undefined
      ? { type: 'agent.tool.result', seq, payload: { toolCallId: id, name } }
      : { type: 'agent.tool.result', seq, payload: { toolCallId: id, name, error } }

  return [requested, result]
}

function vendorCall(name: string, args: Record<string, string>): LoggedEvent[] {
  seq += 2
  const id = `v_${seq}`

  return [
    {
      type: 'shuttle.vendor.tool_started',
      seq: seq - 1,
      payload: { toolCall: { id, name, arguments: args } },
    },
    { type: 'shuttle.vendor.tool_finished', seq, payload: { toolCallId: id, result: '' } },
  ]
}

/** Where a call's result is in the log. */
function finished(events: readonly LoggedEvent[]): number {
  return events.at(-1)?.seq ?? -1
}

describe('readPathEvents', () => {
  test('reading and searching change nothing', () => {
    const events = [
      ...call('read_file', { path: `${ROOT}/web/a.ts` }),
      ...call('grep', { pattern: 'x' }),
      ...vendorCall('Read', { file_path: `${ROOT}/web/a.ts` }),
      ...call('bash', { command: `cd ${ROOT}/web && ls -la && git status` }),
    ]

    expect(readPathEvents(events, RUN)).toEqual({ relistSeq: 0, writes: [] })
  })

  test('a write names its file, relative to the worktree, when it finishes', () => {
    const events = [
      ...call('write_file', { path: `${ROOT}/web/new.ts`, content: 'x' }),
      ...vendorCall('Edit', { file_path: `${ROOT}/web/a.ts` }),
    ]

    const result = readPathEvents(events, RUN)

    expect(result.relistSeq).toBe(0)
    expect(result.writes.map((write) => write.path)).toEqual(['web/new.ts', 'web/a.ts'])
    expect(result.writes[0]?.seq).toBe(finished(events.slice(0, 2)))
  })

  test('a failed write, or one outside the worktree, adds nothing', () => {
    const events = [
      ...call('write_file', { path: `${ROOT}/web/x.ts` }, 'permission denied'),
      ...call('write_file', { path: '/tmp/scratch.txt' }),
    ]

    expect(readPathEvents(events, RUN)).toEqual({ relistSeq: 0, writes: [] })
  })

  test('a shell command that may write, an unknown tool or a moved sandbox means listing again', () => {
    const shell = call('bash', { command: 'npm install && touch x' })
    const unknown = call('stack_layer', { action: 'new' })
    const moved: LoggedEvent = { type: 'shuttle.sandbox.moved', seq: (seq += 1), payload: {} }
    const relative = call('write_file', { path: 'web/rel.ts' })

    expect(readPathEvents(shell, RUN).relistSeq).toBe(finished(shell))
    expect(readPathEvents(unknown, RUN).relistSeq).toBe(finished(unknown))
    expect(readPathEvents([moved], RUN).relistSeq).toBe(moved.seq)
    expect(readPathEvents(relative, RUN).relistSeq).toBe(finished(relative))
  })

  test('a patch that only edits keeps the list; one that adds a file does not', () => {
    const edit = vendorCall('apply_patch', {
      input: '*** Begin Patch\n*** Update File: a.ts\n*** End Patch',
    })

    const add = vendorCall('apply_patch', {
      input: '*** Begin Patch\n*** Add File: b.ts\n*** End Patch',
    })

    expect(readPathEvents(edit, RUN).relistSeq).toBe(0)
    expect(readPathEvents(add, RUN).relistSeq).toBe(finished(add))
  })
})

describe('commandKeepsPaths', () => {
  test.each([
    'ls -la',
    'cd /workspace && rg --files | head -50',
    'git log --oneline -5',
    'git -C web diff',
    'find . -name "*.ts"',
    "sed -n '1,20p' a.ts",
    "git -c user.name='Codex' commit -m done",
    'git add -A && git push origin HEAD',
  ])('reads only: %p', (command) => {
    expect(commandKeepsPaths(command)).toBe(true)
  })

  test.each([
    '',
    'echo hi > a.txt',
    'npm install',
    'git checkout main',
    'git stash',
    'find . -name "*.tmp" -delete',
    "sed -i 's/a/b/' a.ts",
    'ls $(touch x)',
    'mkdir x',
  ])('may write: %p', (command) => {
    expect(commandKeepsPaths(command)).toBe(false)
  })
})

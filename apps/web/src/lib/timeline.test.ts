import { describe, expect, test } from 'bun:test'

import type { FeedItem, ToolCallItem } from './session-feed'
import {
  projectTimeline,
  repeatedMessages,
  threadParents,
  threadPath,
  type TimelineThread,
} from './timeline'

// session → conductor → worker → helper, with a narrator beside the conductor.
const tree: TimelineThread = {
  threadId: 'session',
  children: [
    {
      threadId: 'conductor',
      children: [{ threadId: 'worker', children: [{ threadId: 'helper', children: [] }] }],
    },
    { threadId: 'narrator', children: [] },
  ],
}

const parents = threadParents(tree)
let seq = 0

function user(text: string): FeedItem {
  seq += 1

  return { kind: 'user', id: `u${seq}`, seq, ts: seq, messageId: `m${seq}`, text, goal: false }
}

function agent(threadId: string, text: string): FeedItem {
  seq += 1

  return { kind: 'agent', id: `a${seq}`, seq, ts: seq, threadId, text }
}

function thought(threadId: string, durationMs: number): FeedItem {
  seq += 1

  return { kind: 'thought', id: `t${seq}`, seq, ts: seq, threadId, turn: 1, text: 'hm', durationMs }
}

function call(name: string, path: string, status: ToolCallItem['status'] = 'ok'): ToolCallItem {
  return { toolCallId: `${name}:${path}`, name, args: { path }, seq: 1, status }
}

function tools(threadId: string, calls: ToolCallItem[]): FeedItem {
  seq += 1

  return { kind: 'tools', id: `x${seq}`, seq, ts: seq, threadId, calls, thoughts: [], steps: [] }
}

function question(threadId: string): FeedItem {
  seq += 1

  return {
    kind: 'question',
    id: `q${seq}`,
    seq,
    ts: seq,
    threadId,
    approvalId: `ask_${seq}`,
    title: 'Which database?',
  }
}

const items: FeedItem[] = [
  user('build it'),
  agent('conductor', 'I will delegate.'),
  tools('worker', [call('write_file', 'app.js'), call('bash', 'x', 'error')]),
  agent('narrator', 'Still working.'),
  tools('helper', [call('edit_file', 'style.css')]),
  agent('worker', 'Done with the app.'),
  agent('conductor', 'All finished.'),
]

function idAt(index: number): string {
  return items[index]?.id ?? ''
}

function ids(rows: readonly { id: string }[]): string[] {
  return rows.map((row) => row.id)
}

describe('projectTimeline', () => {
  test('the top level folds delegated work into one row where it began', () => {
    const rows = projectTimeline(items, parents)

    expect(ids(rows)).toEqual([idAt(0), idAt(1), 'delegation_worker', idAt(3), idAt(6)])

    expect(rows[2]).toMatchObject({
      kind: 'delegation',
      threadId: 'worker',
      agents: 2,
      toolCalls: 3,
      failed: 1,
      changedFiles: 2,
      lastText: 'Done with the app.',
    })
  })

  test('the timeline of one agent shows it alone and folds what it delegated', () => {
    const rows = projectTimeline(items, parents, 'worker')

    expect(ids(rows)).toEqual([idAt(2), 'delegation_helper', idAt(5)])
    expect(rows[1]).toMatchObject({ threadId: 'helper', agents: 1, toolCalls: 1, changedFiles: 1 })
  })

  test('a question from a folded agent still shows at the top level', () => {
    const asked = question('helper')
    const rows = projectTimeline([...items, asked], parents)

    expect(rows.at(-1)).toBe(asked)
  })

  test('brief thoughts are dropped and keeps long ones', () => {
    const brief = thought('conductor', 100)
    const long = thought('conductor', 9000)
    const rows = projectTimeline([brief, long], parents)

    expect(rows).toEqual([long])
  })

  test('a thread the tree has not reported yet is shown, not lost', () => {
    const early = agent('unknown', 'hello')

    expect(projectTimeline([early], parents)).toEqual([early])
  })
})

describe('threadPath', () => {
  test('lists the agents from the top down, without the session itself', () => {
    expect(threadPath('helper', parents)).toEqual(['conductor', 'worker', 'helper'])
    expect(threadPath('session', parents)).toEqual([])
  })
})

describe('repeatedMessages', () => {
  test('marks a later message that says the same thing, whoever says it', () => {
    const notice = 'Claude Code is not connected for the person this work is for.'
    const first = agent('narrator', notice)
    const other = agent('conductor', 'I will inspect the repository.')
    const again = agent('conductor', `${notice}  `)

    expect([...repeatedMessages([first, other, again])]).toEqual([again.id])
  })

  test('leaves short messages alone', () => {
    expect(repeatedMessages([agent('worker', 'Done.'), agent('worker', 'Done.')]).size).toBe(0)
  })
})

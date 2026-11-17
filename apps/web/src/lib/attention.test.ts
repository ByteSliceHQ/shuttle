import { describe, expect, test } from 'bun:test'

import {
  activitySnapshot,
  attentionChanges,
  attentionCount,
  type AttentionSession,
} from './attention'

function session(runId: string, activity: string, extra: Partial<AttentionSession> = {}) {
  return { runId, title: `Session ${runId}`, activity, archived: false, ownerId: 'me', ...extra }
}

const index = (...sessions: AttentionSession[]) =>
  Object.fromEntries(sessions.map((entry) => [entry.runId, entry]))

describe('attentionCount', () => {
  test('counts own sessions that are waiting or failed, but not the one on screen', () => {
    const sessions = index(
      session('a', 'needs_input'),
      session('b', 'error'),
      session('c', 'working'),
      session('d', 'needs_input', { ownerId: 'someone-else' }),
      session('e', 'needs_input', { ownerId: 'someone-else', memberIds: ['me'] }),
      session('f', 'needs_input', { archived: true }),
    )

    expect(attentionCount(sessions, 'me', null)).toBe(3)
    expect(attentionCount(sessions, 'me', 'a')).toBe(2)
  })
})

describe('attentionChanges', () => {
  test('reports a session that stopped working, and how', () => {
    const before = activitySnapshot(
      index(session('a', 'working'), session('b', 'working'), session('c', 'working')),
      'me',
    )

    const after = index(session('a', 'needs_input'), session('b', 'idle'), session('c', 'working'))

    expect(attentionChanges(before, after, 'me')).toEqual([
      { runId: 'a', title: 'Session a', kind: 'needs_input' },
      { runId: 'b', title: 'Session b', kind: 'finished' },
    ])
  })

  test('says nothing about sessions it had not seen working', () => {
    const after = index(session('a', 'needs_input'), session('b', 'idle'))

    expect(attentionChanges({}, after, 'me')).toEqual([])
    expect(attentionChanges({ a: 'needs_input', b: 'idle' }, after, 'me')).toEqual([])
  })

  test("ignores other people's sessions", () => {
    const theirs = { ownerId: 'someone-else' }
    const before = activitySnapshot(index(session('a', 'working', theirs)), 'someone-else')

    expect(attentionChanges(before, index(session('a', 'idle', theirs)), 'me')).toEqual([])
  })
})

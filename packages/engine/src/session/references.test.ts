import { describe, expect, test } from 'bun:test'

import { MessageReferenceInput } from '@shuttle/api'

import { referenceManifest } from './references'

const RUN = 'o-orgA-session_1'

describe('referenceManifest', () => {
  test('says nothing when a message points at nothing', () => {
    expect(referenceManifest(RUN, undefined)).toBe('')
    expect(referenceManifest(RUN, [])).toBe('')
  })

  test('lists files by worktree path and sessions with their digest', () => {
    expect(
      referenceManifest(RUN, [
        { kind: 'file', path: 'web/README.md' },
        { kind: 'session', sessionId: 'o-orgA-s2', title: 'Login', digest: 'Goal: a\nStatus: b' },
        { kind: 'session', sessionId: 'o-orgA-s3', title: 'Empty' },
      ]),
    ).toBe(
      [
        "Files the message points at, in the session's worktree:",
        `- web/README.md: /workspace/.wt/${RUN}/web/README.md`,
        '',
        'Other sessions the message points at. You cannot open them; this is what they say:',
        '- "Login" (o-orgA-s2)',
        '  Goal: a',
        '  Status: b',
        '- "Empty" (o-orgA-s3)',
      ].join('\n'),
    )
  })
})

describe('two sessions with the same title', () => {
  test('says which mention is which', () => {
    expect(
      referenceManifest(RUN, [
        { kind: 'session', sessionId: 'o-orgA-s2', title: 'todo app', label: 'todo app' },
        { kind: 'session', sessionId: 'o-orgA-s3', title: 'todo app', label: 'todo app (2)' },
      ]),
    ).toContain('- "todo app" (o-orgA-s2)\n- "todo app" (o-orgA-s3), written as @todo app (2)')
  })
})

describe('MessageReferenceInput', () => {
  test('accepts a path inside the worktree', () => {
    expect(MessageReferenceInput.safeParse({ kind: 'file', path: 'web/src/a.ts' }).success).toBe(
      true,
    )
  })

  test.each(['/etc/passwd', '../x', 'web/../../x', 'web//a', 'web/./a', ''])(
    'refuses %p',
    (path) => {
      expect(MessageReferenceInput.safeParse({ kind: 'file', path }).success).toBe(false)
    },
  )
})

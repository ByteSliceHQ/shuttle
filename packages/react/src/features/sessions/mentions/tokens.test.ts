import { describe, expect, test } from 'bun:test'

import {
  mentionReferencesOf,
  splitMentions,
  uniqueMentionLabel,
  type MentionReference,
} from './tokens'

const app: MentionReference = { kind: 'file', path: 'web/app.ts' }
const web: MentionReference = { kind: 'file', path: 'web' }
const calc: MentionReference = { kind: 'session', sessionId: 's2', title: 'build a calculator' }

describe('splitMentions', () => {
  test('cuts out each reference, keeping the text around it', () => {
    expect(splitMentions('see @web/app.ts and @build a calculator ?', [app, calc])).toEqual([
      { start: 0, text: 'see ' },
      { start: 4, text: '@web/app.ts', reference: app },
      { start: 15, text: ' and ' },
      { start: 20, text: '@build a calculator', reference: calc },
      { start: 39, text: ' ?' },
    ])
  })

  test('prefers the longer token at the same @', () => {
    expect(splitMentions('@web/app.ts', [web, app])).toEqual([
      { start: 0, text: '@web/app.ts', reference: app },
    ])
  })

  test('does not match a token that runs on into a longer word or path', () => {
    expect(splitMentions('@web/other.ts', [web])).toEqual([{ start: 0, text: '@web/other.ts' }])
  })

  test('ends a token at punctuation', () => {
    expect(splitMentions('see @web/app.ts.', [app])).toEqual([
      { start: 0, text: 'see ' },
      { start: 4, text: '@web/app.ts', reference: app },
      { start: 15, text: '.' },
    ])
  })

  test('leaves text with no references as one run', () => {
    expect(splitMentions('plain @text', [])).toEqual([{ start: 0, text: 'plain @text' }])
    expect(splitMentions('', [app])).toEqual([])
  })
})

describe('mentionReferencesOf', () => {
  test('keeps the references it can read and drops the rest', () => {
    expect(
      mentionReferencesOf([
        { kind: 'file', path: 'web/app.ts' },
        { kind: 'session', sessionId: 's2', title: 'build a calculator', digest: 'x' },
        { kind: 'session', sessionId: 's4', title: 'todo', label: 'todo (2)' },
        { kind: 'session', sessionId: 's3' },
        { kind: 'pull', number: 4 },
        'nonsense',
      ]),
    ).toEqual([app, calc, { kind: 'session', sessionId: 's4', title: 'todo', label: 'todo (2)' }])

    expect(mentionReferencesOf(undefined)).toEqual([])
  })
})

describe('two sessions with the same title', () => {
  const first: MentionReference = { kind: 'session', sessionId: 's1', title: 'todo app' }

  const second: MentionReference = {
    kind: 'session',
    sessionId: 's2',
    title: 'todo app',
    label: 'todo app (2)',
  }

  test('each mention links to its own session', () => {
    expect(splitMentions('@todo app vs @todo app (2)', [first, second])).toEqual([
      { start: 0, text: '@todo app', reference: first },
      { start: 9, text: ' vs ' },
      { start: 13, text: '@todo app (2)', reference: second },
    ])
  })
})

describe('uniqueMentionLabel', () => {
  const inUse = [
    { label: 'todo app', identity: 'session:s1' },
    { label: 'todo app (2)', identity: 'session:s2' },
  ]

  test('numbers a different thing with a label already in use', () => {
    expect(uniqueMentionLabel('todo app', 'session:s3', inUse)).toBe('todo app (3)')
    expect(uniqueMentionLabel('other', 'session:s4', inUse)).toBe('other')
  })

  test('writes something already mentioned the way it was', () => {
    expect(uniqueMentionLabel('todo app', 'session:s2', inUse)).toBe('todo app (2)')
  })
})

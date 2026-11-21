import { describe, expect, test } from 'bun:test'

import { fitPastedMentions, mentionClipboard, readMentionClipboard } from './clipboard'
import type { MentionReference } from './tokens'

const readme: MentionReference = { kind: 'file', path: 'demo/README.md' }
const todo: MentionReference = { kind: 'session', sessionId: 's1', title: 'todo "app" <x>' }
const other: MentionReference = { kind: 'session', sessionId: 's9', title: 'unused' }

describe('the clipboard round trip', () => {
  test('carries the text and only the references in it', () => {
    const text = 'see @demo/README.md\nand @todo "app" <x>'
    const { plain, html } = mentionClipboard(text, [readme, todo, other])

    expect(plain).toBe(text)
    expect(html).toContain('<br>')
    expect(readMentionClipboard(html ?? '', plain)).toEqual({ text, references: [readme, todo] })
  })

  test('puts nothing extra on the clipboard for text without mentions', () => {
    expect(mentionClipboard('plain', [readme])).toEqual({ plain: 'plain', html: null })
  })

  test('survives a browser rewriting the line breaks', () => {
    const { html } = mentionClipboard('a @demo/README.md\nb', [readme])

    expect(readMentionClipboard(html ?? '', 'a @demo/README.md\r\nb')?.references).toEqual([readme])
  })

  test('reads nothing back when the text no longer matches, or from other HTML', () => {
    const { html } = mentionClipboard('see @demo/README.md', [readme])

    expect(readMentionClipboard(html ?? '', 'see something else')).toBeNull()
    expect(readMentionClipboard('<b>hi</b>', 'hi')).toBeNull()
    expect(readMentionClipboard('<span data-shuttle-mentions="{nope">x</span>', 'x')).toBeNull()
  })
})

describe('fitPastedMentions', () => {
  const pastedTodo: MentionReference = { kind: 'session', sessionId: 's2', title: 'todo' }

  test('numbers a pasted session whose text means another one in the message', () => {
    expect(
      fitPastedMentions(
        { text: 'like @todo and @demo/README.md', references: [pastedTodo, readme] },
        [{ label: 'todo', identity: 'session:s1' }],
      ),
    ).toEqual({
      text: 'like @todo (2) and @demo/README.md',
      references: [{ ...pastedTodo, label: 'todo (2)' }, readme],
    })
  })

  test('writes a session already in the message the way it is written there', () => {
    expect(
      fitPastedMentions(
        { text: '@todo (3) again', references: [{ ...pastedTodo, label: 'todo (3)' }] },
        [{ label: 'todo (2)', identity: 'session:s2' }],
      ),
    ).toEqual({ text: '@todo (2) again', references: [{ ...pastedTodo, label: 'todo (2)' }] })
  })
})

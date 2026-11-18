import { describe, expect, test } from 'bun:test'

import { MAX_ATTACHMENTS } from '../sessions/media'
import { ATTACHMENT_LIMIT_MESSAGE, pasteAttachments } from './paste-attachments'

const png = (name = 'screen.png') => new File(['image'], name, { type: 'image/png' })

describe('pasting into a composer', () => {
  test('a plain text paste is left alone', () => {
    expect(pasteAttachments([], [], true)).toEqual({ files: [], error: null, takeOver: false })
  })

  test('a screenshot is attached in place of the default paste', () => {
    const shot = png()

    expect(pasteAttachments([], [shot], false)).toEqual({
      files: [shot],
      error: null,
      takeOver: true,
    })
  })

  test('text copied with a picture of it still reaches the textarea', () => {
    const result = pasteAttachments([], [png()], true)

    expect(result.takeOver).toBe(false)
    expect(result.files).toHaveLength(1)
  })

  test('a paste over the limit attaches nothing and never swallows text', () => {
    const full = Array.from({ length: MAX_ATTACHMENTS }, (_, index) => png(`${index}.png`))

    for (const hasText of [true, false]) {
      expect(pasteAttachments(full, [png()], hasText)).toEqual({
        files: full,
        error: ATTACHMENT_LIMIT_MESSAGE,
        takeOver: false,
      })
    }

    expect(pasteAttachments([], [new File([], 'empty.png')], false).error).toBe(
      ATTACHMENT_LIMIT_MESSAGE,
    )
  })
})

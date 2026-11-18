import { describe, expect, test } from 'bun:test'

import { commitsToPullText } from './prepare-pr-publish-gate'

const log = (...commits: [string, string][]) =>
  commits.map(([subject, body]) => `${subject}\x1f${body}\x1e\n`).join('')

describe('commitsToPullText', () => {
  test('one commit gives its own subject and body', () => {
    expect(commitsToPullText(log(['feat: attachments', 'Picker, paste and drop.\n']))).toEqual({
      title: 'feat: attachments',
      body: 'Picker, paste and drop.',
    })
  })

  test('several give the first subject and a list of them all', () => {
    expect(commitsToPullText(log(['feat: attachments', ''], ['test: cover upload', 'x']))).toEqual({
      title: 'feat: attachments',
      body: '- feat: attachments\n- test: cover upload',
    })
  })

  test('none gives nothing', () => {
    expect(commitsToPullText('')).toBeNull()
  })
})

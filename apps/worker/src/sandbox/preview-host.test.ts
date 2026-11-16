import { describe, expect, test } from 'bun:test'

import { isOwnHost, parsePreviewHost } from './preview-host'

describe('parsePreviewHost', () => {
  test('reads the port and the label', () => {
    expect(parsePreviewHost('p3000-abc123.shuttle.example')).toEqual({
      port: 3000,
      folderId: 'abc123',
    })
  })

  test('is not fooled by the app or by other names', () => {
    expect(parsePreviewHost('app.shuttle.example')).toBeNull()
    expect(parsePreviewHost('p99999-abc.shuttle.example')).toBeNull()
  })
})

describe('isOwnHost', () => {
  const webUrl = 'https://app.shuttle.example'

  test('knows the app', () => {
    expect(isOwnHost('app.shuttle.example', webUrl)).toBe(true)
  })

  test('turns away other names under the same domain', () => {
    expect(isOwnHost('mail.shuttle.example', webUrl)).toBe(false)
    expect(isOwnHost('shuttle.example', webUrl)).toBe(false)
  })

  test('leaves development alone', () => {
    expect(isOwnHost('localhost', 'http://127.0.0.1:5180')).toBe(true)
    expect(isOwnHost('127.0.0.1', 'http://127.0.0.1:5180')).toBe(true)
    expect(isOwnHost('anything.example', undefined)).toBe(true)
  })
})

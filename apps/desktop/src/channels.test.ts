import { describe, expect, test } from 'bun:test'

import { appPath, deepLinkPath } from './channels'

describe('deepLinkPath', () => {
  test('turns a shuttle link into a path inside the app', () => {
    expect(deepLinkPath('shuttle://sessions/o-abc-session_123')).toBe('/sessions/o-abc-session_123')
    expect(deepLinkPath('shuttle://sessions/abc?view=thr_1')).toBe('/sessions/abc?view=thr_1')
    expect(deepLinkPath('shuttle://')).toBe('/')
  })

  test('refuses anything that is not a shuttle link or would leave the app', () => {
    expect(deepLinkPath('https://example.com/sessions/abc')).toBeNull()
    expect(deepLinkPath('shuttle://sessions/a b')).toBeNull()
    expect(deepLinkPath('shuttle://sessions/<script>')).toBeNull()
  })
})

describe('appPath', () => {
  test('accepts paths and refuses other origins', () => {
    expect(appPath('/sessions/abc')).toBe('/sessions/abc')
    expect(appPath('//evil.example/x')).toBeNull()
    expect(appPath('https://evil.example')).toBeNull()
    expect(appPath(undefined)).toBeNull()
  })
})

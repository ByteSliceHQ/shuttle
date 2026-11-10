import { describe, expect, test } from 'bun:test'

import { compactRelativeTime } from './time'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const now = Date.UTC(2026, 10, 9)

describe('compactRelativeTime', () => {
  test('rolls long gaps up instead of counting days forever', () => {
    expect(compactRelativeTime(now - 20_000, now)).toBe('now')
    expect(compactRelativeTime(now - 3 * MINUTE, now)).toBe('3m')
    expect(compactRelativeTime(now - 5 * 60 * MINUTE, now)).toBe('5h')
    expect(compactRelativeTime(now - 6 * DAY, now)).toBe('6d')
    expect(compactRelativeTime(now - 12 * DAY, now)).toBe('1w')
    expect(compactRelativeTime(now - 40 * DAY, now)).toBe('1mo')
    expect(compactRelativeTime(now - 330 * DAY, now)).toBe('11mo')
    expect(compactRelativeTime(now - 3 * 365 * DAY, now)).toBe('3y')
  })

  test('clamps clock skew to now', () => {
    expect(compactRelativeTime(now + 5 * MINUTE, now)).toBe('now')
  })
})

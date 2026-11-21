import { describe, expect, test } from 'bun:test'

import { expiryOf, hasExpired, neverExpire } from './approvals'

const request = { kind: 'publish-pull-request', approvalId: 'a1', orgId: 'org1' } as const

describe('approval expiry', () => {
  test('standalone approvals never expire', () => {
    expect(expiryOf(neverExpire, request, 1_000)).toBeNull()
  })

  test('a host policy sets the time a decision is no longer accepted', () => {
    expect(expiryOf({ expiresAfterMs: () => 60_000 }, request, 1_000)).toBe(61_000)
  })

  test('a policy that is not a usable time means never', () => {
    expect(expiryOf({ expiresAfterMs: () => Number.NaN }, request, 1_000)).toBeNull()
    expect(expiryOf({ expiresAfterMs: () => Number.POSITIVE_INFINITY }, request, 1)).toBeNull()
  })

  test('a decision is late only after the expiry', () => {
    expect(hasExpired(null, 99)).toBe(false)
    expect(hasExpired(undefined, 99)).toBe(false)
    expect(hasExpired(100, 100)).toBe(false)
    expect(hasExpired(100, 101)).toBe(true)
  })
})

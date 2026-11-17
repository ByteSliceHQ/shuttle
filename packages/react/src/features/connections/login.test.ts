import { describe, expect, test } from 'bun:test'

import type { LoginEvent, LoginProgress } from '@shuttle/api'

import { loginOutcome, loginSettled, mergeProgress, type LoginPrompt } from './login'

function prompt(seq: number, code = ''): LoginPrompt {
  return { type: 'login_prompt', url: `https://vendor.test/${seq}`, code, seq, at: seq * 10 }
}

function ended(seq: number, success: boolean, error?: string): LoginEvent {
  return { type: 'login_done', success, error, seq, at: seq * 10 }
}

function page(events: LoginEvent[], offset: number, rest: Partial<LoginProgress> = {}) {
  return { events, offset, done: false, connected: false, ...rest }
}

describe('mergeProgress', () => {
  test('the first read is kept as it is', () => {
    const first = page([prompt(1)], 40)

    expect(mergeProgress(undefined, first)).toBe(first)
  })

  test('later reads add their events after the earlier ones and move the offset on', () => {
    const merged = mergeProgress(
      mergeProgress(page([prompt(1)], 40), page([], 40)),
      page([prompt(3), ended(4, true)], 120, { done: true, connected: true }),
    )

    expect(merged.events.map((event) => event.seq)).toEqual([1, 3, 4])
    expect(merged.offset).toBe(120)
    expect(merged.done).toBe(true)
    expect(merged.connected).toBe(true)
  })

  test('a read made twice from the same offset adds nothing the second time', () => {
    const first = page([prompt(1)], 40)
    const again = page([prompt(2), prompt(3)], 90)
    const once = mergeProgress(first, again)

    expect(mergeProgress(once, again)).toEqual(once)
  })

  test('an overlapping read adds only what is new', () => {
    const merged = mergeProgress(page([prompt(1), prompt(2)], 60), page([prompt(2), prompt(3)], 90))

    expect(merged.events.map((event) => event.seq)).toEqual([1, 2, 3])
  })
})

describe('loginOutcome', () => {
  test('waits without a prompt until the CLI prints one', () => {
    expect(loginOutcome(page([], 0))).toEqual({ status: 'waiting', prompt: null })
  })

  test('shows the latest prompt', () => {
    const outcome = loginOutcome(page([prompt(1, 'AAAA'), prompt(2, 'BBBB')], 80))

    expect(outcome).toEqual({ status: 'waiting', prompt: prompt(2, 'BBBB') })
  })

  test('fails with what the CLI said went wrong', () => {
    const progress = page([prompt(1), ended(2, false, 'Code expired.')], 80, { done: true })

    expect(loginOutcome(progress)).toEqual({ status: 'failed', error: 'Code expired.' })
    expect(loginSettled(progress)).toBe(true)
  })

  test('fails in plain words when the CLI gave no reason', () => {
    expect(loginOutcome(page([ended(1, false)], 30, { done: true }))).toEqual({
      status: 'failed',
      error: 'Sign-in did not complete.',
    })
  })

  test('is connected once the Worker has the sign-in', () => {
    const progress = page([prompt(1), ended(2, true)], 80, { done: true, connected: true })

    expect(loginOutcome(progress)).toEqual({ status: 'connected' })
  })

  test('a success the Worker could not keep is a failure', () => {
    const progress = page([ended(1, true)], 30, { done: true, error: 'Left no sign-in files.' })

    expect(loginOutcome(progress)).toEqual({ status: 'failed', error: 'Left no sign-in files.' })
  })

  test('a sign-in that ended with nothing to show for it is not waited on', () => {
    expect(loginSettled(page([prompt(1)], 40, { done: true }))).toBe(true)
  })

  test('a sign-in under way is not settled', () => {
    expect(loginSettled(page([prompt(1)], 40))).toBe(false)
  })
})

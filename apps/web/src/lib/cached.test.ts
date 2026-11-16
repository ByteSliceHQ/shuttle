import { beforeEach, describe, expect, test } from 'bun:test'

import { cachedFetch, clearCached, invalidateCached, peekCached, putCached } from './cached'

describe('cachedFetch', () => {
  beforeEach(clearCached)

  test('shares one request between overlapping reads and keeps the answer', async () => {
    let calls = 0

    const load = () => {
      calls += 1

      return Promise.resolve({ n: calls })
    }

    const [first, second] = await Promise.all([cachedFetch('k', load), cachedFetch('k', load)])

    expect(calls).toBe(1)
    expect(first).toBe(second)
    expect(peekCached<{ n: number }>('k')).toEqual({ n: 1 })
  })

  test('asks again on the next read, showing the kept value meanwhile', async () => {
    let calls = 0

    const load = () => {
      calls += 1

      return Promise.resolve(calls)
    }

    await cachedFetch('k', load)
    const again = cachedFetch('k', load)

    expect(peekCached<number>('k')).toBe(1)
    expect(await again).toBe(2)
  })

  test('a write made during a read is not overwritten by what the read brings back', async () => {
    let finish!: (value: string) => void

    // oxlint-disable-next-line effecttsgo/new-promise
    const slow = new Promise<string>((resolve) => {
      finish = resolve
    })

    const reading = cachedFetch('k', () => slow)
    putCached('k', 'written')
    finish('stale')
    await reading

    expect(peekCached<string>('k')).toBe('written')
  })

  test('a failed read keeps the last value and lets the next read try again', async () => {
    putCached('k', 'kept')

    expect(cachedFetch('k', () => Promise.reject(new Error('down')))).rejects.toThrow('down')
    await cachedFetch('k', () => Promise.reject(new Error('down'))).catch(() => undefined)

    expect(peekCached<string>('k')).toBe('kept')
    expect(await cachedFetch('k', () => Promise.resolve('back'))).toBe('back')
  })

  test('invalidating starts a new request while one is in flight', async () => {
    let calls = 0

    const load = () => {
      calls += 1

      return Promise.resolve(calls)
    }

    const first = cachedFetch('k', load)
    invalidateCached('k')
    const second = cachedFetch('k', load)

    expect(await first).toBe(1)
    expect(await second).toBe(2)
    expect(peekCached<number>('k')).toBe(2)
  })
})

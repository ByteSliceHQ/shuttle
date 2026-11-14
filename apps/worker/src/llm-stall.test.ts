import { describe, expect, test } from 'bun:test'

import { ModelStalledError, stallGuard } from './llm-stall'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('stallGuard', () => {
  test('aborts a call that has gone silent, and says why', async () => {
    const guard = stallGuard(undefined, 20)

    await sleep(40)

    expect(guard.signal.aborted).toBe(true)
    expect(guard.stalled()).toBe(true)
    expect(guard.signal.reason).toBeInstanceOf(ModelStalledError)
  })

  test('a reply that keeps arriving is left alone, however long it takes', async () => {
    const guard = stallGuard(undefined, 30)

    for (let part = 0; part < 5; part++) {
      await sleep(15)
      guard.touch()
    }

    expect(guard.signal.aborted).toBe(false)
    guard.done()

    // Once the reply is over, the guard does nothing more.
    await sleep(45)
    expect(guard.signal.aborted).toBe(false)
  })

  test("the caller's own cancel still reaches the call, and is not mistaken for a stall", () => {
    const caller = new AbortController()
    const guard = stallGuard(caller.signal, 1000)

    caller.abort(new Error('stopped by a person'))

    expect(guard.signal.aborted).toBe(true)
    expect(guard.stalled()).toBe(false)
    expect((guard.signal.reason as Error).message).toBe('stopped by a person')
    guard.done()
  })

  test('a call that was cancelled before it began starts out aborted', () => {
    const guard = stallGuard(AbortSignal.abort(), 1000)

    expect(guard.signal.aborted).toBe(true)
    expect(guard.stalled()).toBe(false)
  })
})

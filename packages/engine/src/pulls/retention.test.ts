import { describe, expect, test } from 'bun:test'

import { MAX_RETAINED_CLOSED_PULLS, retainPulls } from './retention'

const pull = (updatedAt: number, state: 'open' | 'closed') => ({ updatedAt, state })

describe('retainPulls', () => {
  test('keeps every pull while the closed ones fit', () => {
    const pulls = { 'acme/one#1': pull(1, 'closed'), 'acme/one#2': pull(2, 'open') }

    expect(retainPulls(pulls)).toBe(pulls)
  })

  test('drops the oldest closed pulls past the cap and keeps every open one', () => {
    const closed = Object.fromEntries(
      Array.from({ length: MAX_RETAINED_CLOSED_PULLS + 1 }, (_, index) => [
        `acme/one#${index}`,
        pull(index, 'closed'),
      ]),
    )

    const pulls = { ...closed, 'acme/one#open': pull(0, 'open') }

    const kept = retainPulls(pulls)

    expect(Object.keys(kept)).toHaveLength(MAX_RETAINED_CLOSED_PULLS + 1)
    expect(kept['acme/one#open']).toBeDefined()
    expect(kept['acme/one#0']).toBeUndefined()
    expect(kept[`acme/one#${MAX_RETAINED_CLOSED_PULLS}`]).toBeDefined()
  })
})

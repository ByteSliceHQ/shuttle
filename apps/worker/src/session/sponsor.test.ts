import { describe, expect, test } from 'bun:test'

import { ACCESS_STORAGE_KEY } from '../tenancy/access'
import { readSponsor, resolveSponsor, sponsorOfMessages, SPONSOR_STORAGE_KEY } from './sponsor'

function memoryStorage(initial: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(initial))
  let writes = 0

  const storage = {
    get: async (key: string) => values.get(key),
    put: async (key: string, value: unknown) => {
      writes += 1
      values.set(key, value)
    },
  } as unknown as Pick<DurableObjectStorage, 'get' | 'put'>

  return { storage, values, writes: () => writes }
}

const owned = {
  [ACCESS_STORAGE_KEY]: { ownerId: 'alice', memberIds: ['bob'], visibility: 'private' },
}

const user = (content: string, name?: string) => ({ role: 'user' as const, content, name })
const assistant = (content: string) => ({ role: 'assistant' as const, content })

describe('sponsorOfMessages', () => {
  test('is the author of the latest message that asked for work', () => {
    expect(
      sponsorOfMessages([
        user('build it'),
        user('add dark mode', 'alice'),
        assistant('done'),
        user('add a footer', 'bob'),
        // A brief change carries nobody's name.
        user('Brief v2: Alice: keep it accessible'),
      ]),
    ).toBe('bob')
  })

  test('is nobody when no one has asked by name', () => {
    expect(sponsorOfMessages([user('build it'), assistant('ok')])).toBeNull()
  })
})

describe('resolveSponsor', () => {
  test('a session nobody has asked anything of runs for its owner', async () => {
    const { storage } = memoryStorage(owned)

    expect(await resolveSponsor(storage, [user('build it')])).toBe('alice')
    expect(await readSponsor(storage)).toBe('alice')
  })

  test('a session Shuttle started, which nobody has spoken in, runs for no one', async () => {
    const { storage } = memoryStorage()

    expect(await resolveSponsor(storage, [user('review this')])).toBeNull()
  })

  test('the person who asked is remembered for the agents the conductor delegates to', async () => {
    const { storage, values, writes } = memoryStorage(owned)

    expect(await resolveSponsor(storage, [user('add a footer', 'bob')])).toBe('bob')
    expect(values.get(SPONSOR_STORAGE_KEY)).toBe('bob')

    // A delegated agent sees only the conductor's instructions.
    expect(await resolveSponsor(storage, [user('Implement the footer')])).toBe('bob')
    expect(await readSponsor(storage)).toBe('bob')

    // Asking again does not write again.
    await resolveSponsor(storage, [user('add a footer', 'bob')])
    expect(writes()).toBe(1)
  })
})

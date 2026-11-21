import { describe, expect, test } from 'bun:test'

import {
  canOpenSession,
  canShareSession,
  isPublicSession,
  readSessionAccess,
  SessionAccessSchema,
  type SessionAccess,
  writeSessionAccess,
} from './access'

const alice = { userId: 'alice', role: 'member' as const }
const bob = { userId: 'bob', role: 'member' as const }
const admin = { userId: 'carol', role: 'admin' as const }

function memoryStorage() {
  const values = new Map<string, unknown>()

  return {
    // SAFETY: the fake hands back exactly what was `put`, so the caller's `T` is what it stored.
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key: string, value: SessionAccess) => {
      values.set(key, value)
    },
  }
}

describe('session access', () => {
  const privateSession = { ownerId: 'alice', memberIds: [], visibility: 'private' as const }

  test('a private session opens for its owner and the people it is shared with only', () => {
    expect(canOpenSession(privateSession, alice)).toBe(true)
    expect(canOpenSession(privateSession, bob)).toBe(false)
    expect(canOpenSession({ ...privateSession, memberIds: ['bob'] }, bob)).toBe(true)
    // Being an organization admin does not open someone's private session.
    expect(canOpenSession(privateSession, admin)).toBe(false)
  })

  test('a public session opens for everyone in the organization', () => {
    const publicSession = { ...privateSession, visibility: 'public' as const }

    expect(canOpenSession(publicSession, bob)).toBe(true)
    expect(isPublicSession(publicSession)).toBe(true)
    expect(isPublicSession(privateSession)).toBe(false)
  })

  test('a session Shuttle started is public', () => {
    expect(canOpenSession(null, bob)).toBe(true)
    expect(isPublicSession(null)).toBe(true)

    // With no owner there is no one it could be private to, whatever was asked for.
    expect(
      SessionAccessSchema.parse({ ownerId: null, memberIds: [], visibility: 'private' }),
    ).toEqual({
      ownerId: null,
      memberIds: [],
      visibility: 'public',
    })
  })

  test('only the owner changes who can open a session', () => {
    const shared = { ...privateSession, memberIds: ['bob'] }

    expect(canShareSession(shared, alice)).toBe(true)
    expect(canShareSession(shared, bob)).toBe(false)
    expect(canShareSession(shared, admin)).toBe(false)
    expect(canShareSession(null, bob)).toBe(false)
  })

  test('a stored record is private by default, cleaned up, and refused when malformed', async () => {
    const storage = memoryStorage()

    expect(await readSessionAccess(storage)).toBeNull()

    const saved = await writeSessionAccess(storage, {
      ownerId: 'alice',
      memberIds: ['bob', 'bob', 'alice', 7],
    })

    expect(saved).toEqual({ ownerId: 'alice', memberIds: ['bob'], visibility: 'private' })
    expect(await readSessionAccess(storage)).toEqual(saved)

    expect(
      SessionAccessSchema.parse({ ownerId: 'alice', memberIds: [], visibility: 'public' })
        .visibility,
    ).toBe('public')

    expect(SessionAccessSchema.safeParse({ ownerId: 'alice' }).success).toBe(false)
    expect(SessionAccessSchema.safeParse({ memberIds: [] }).success).toBe(false)

    return expect(writeSessionAccess(storage, 'everyone')).rejects.toThrow('invalid session access')
  })
})

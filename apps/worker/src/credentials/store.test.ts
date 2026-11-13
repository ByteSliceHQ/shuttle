import { describe, expect, test } from 'bun:test'

import {
  createCredentialStore,
  CredentialsKeyMissingError,
  DEPLOYMENT_OWNER,
  type CredentialStorage,
} from './store'

function memoryStorage(): CredentialStorage & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>()

  return {
    values,
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key, value) => {
      values.set(key, value)
    },
    delete: async (key) => values.delete(key),
    list: async <T>({ prefix }: { prefix: string }) =>
      new Map([...values].filter(([key]) => key.startsWith(prefix))) as Map<string, T>,
  }
}

const secret = 'test-secret-0123456789abcdef0123456789abcdef'

describe('credential store', () => {
  test('round-trips a payload and never stores it in the clear', async () => {
    const storage = memoryStorage()
    const store = createCredentialStore({ storage, secret })

    const payload = {
      env: { CURSOR_API_KEY: 'key-very-secret' },
      files: { '.codex/auth.json': btoa('{"token":"file-very-secret"}') },
    }

    await store.put(DEPLOYMENT_OWNER, 'cursor', payload)

    expect(await store.get(DEPLOYMENT_OWNER, 'cursor')).toEqual(payload)

    const raw = JSON.stringify([...storage.values])

    expect(raw).not.toContain('key-very-secret')
    expect(raw).not.toContain(payload.files['.codex/auth.json'])
  })

  test('returns null for a harness that is not connected', async () => {
    const store = createCredentialStore({ storage: memoryStorage(), secret })

    expect(await store.get(DEPLOYMENT_OWNER, 'codex')).toBeNull()
  })

  test('lists connected harnesses per owner without the secret', async () => {
    const storage = memoryStorage()
    const store = createCredentialStore({ storage, secret, now: () => 1234 })

    await store.put(DEPLOYMENT_OWNER, 'codex', { env: { A: '1' } })
    await store.put(DEPLOYMENT_OWNER, 'acp:goose', { env: { B: '2' } })
    await store.put('someone-else', 'cursor', { env: { C: '3' } })

    const listed = await createCredentialStore({ storage, secret: undefined }).list(
      DEPLOYMENT_OWNER,
    )

    expect(listed.toSorted((a, b) => a.harness.localeCompare(b.harness))).toEqual([
      { harness: 'acp:goose', updatedAt: 1234 },
      { harness: 'codex', updatedAt: 1234 },
    ])
  })

  test('removes a credential', async () => {
    const store = createCredentialStore({ storage: memoryStorage(), secret })

    await store.put(DEPLOYMENT_OWNER, 'codex', { env: { A: '1' } })

    expect(await store.remove(DEPLOYMENT_OWNER, 'codex')).toBe(true)
    expect(await store.get(DEPLOYMENT_OWNER, 'codex')).toBeNull()
    expect(await store.remove(DEPLOYMENT_OWNER, 'codex')).toBe(false)
  })

  test('a record moved to another slot does not decrypt', async () => {
    const storage = memoryStorage()
    const store = createCredentialStore({ storage, secret })

    await store.put(DEPLOYMENT_OWNER, 'codex', { env: { A: '1' } })

    storage.values.set(
      'shuttle:credential:deployment:cursor',
      storage.values.get('shuttle:credential:deployment:codex'),
    )

    expect(store.get(DEPLOYMENT_OWNER, 'cursor')).rejects.toThrow()
  })

  test('a different secret does not decrypt', async () => {
    const storage = memoryStorage()

    await createCredentialStore({ storage, secret }).put(DEPLOYMENT_OWNER, 'codex', {
      env: { A: '1' },
    })

    const other = createCredentialStore({ storage, secret: `${secret}-rotated` })

    expect(other.get(DEPLOYMENT_OWNER, 'codex')).rejects.toThrow()
  })

  test('refuses to store without a key', async () => {
    const store = createCredentialStore({ storage: memoryStorage(), secret: '  ' })

    expect(store.put(DEPLOYMENT_OWNER, 'codex', { env: { A: '1' } })).rejects.toBeInstanceOf(
      CredentialsKeyMissingError,
    )
  })

  test('rejects an owner that could collide with another key', async () => {
    const store = createCredentialStore({ storage: memoryStorage(), secret })

    expect(store.put('a:b', 'codex', {})).rejects.toThrow('invalid credential owner')
  })
})

import { parseHarness, type VendorHarnessId } from '../harness'

const KEY_PREFIX = 'shuttle:credential:'
const OWNER_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** What a vendor agent needs to run signed in. */
export interface CredentialPayload {
  /** Environment variables for the agent process, such as an API key. */
  readonly env?: Readonly<Record<string, string>>
  /** Files under the agent's home directory, keyed by relative path, as base64. */
  readonly files?: Readonly<Record<string, string>>
}

export interface CredentialSummary {
  readonly harness: VendorHarnessId
  readonly updatedAt: number
}

interface StoredCredential {
  readonly v: 1
  readonly iv: string
  readonly data: string
  readonly updatedAt: number
}

/** The slice of Durable Object storage the store needs. */
export interface CredentialStorage {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
  list<T>(options: { prefix: string }): Promise<Map<string, T>>
}

export class CredentialsKeyMissingError extends Error {
  constructor() {
    super('SHUTTLE_CREDENTIALS_KEY is not set; subscriptions cannot be stored')
    this.name = 'CredentialsKeyMissingError'
  }
}

export interface CredentialStore {
  put(owner: string, harness: VendorHarnessId, payload: CredentialPayload): Promise<void>
  get(owner: string, harness: VendorHarnessId): Promise<CredentialPayload | null>
  remove(owner: string, harness: VendorHarnessId): Promise<boolean>
  /** Connected harnesses for `owner`. Does not decrypt anything. */
  list(owner: string): Promise<CredentialSummary[]>
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''

  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary)
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes
}

function ownerPrefix(owner: string): string {
  if (!OWNER_PATTERN.test(owner)) {
    throw new Error('invalid credential owner')
  }

  return `${KEY_PREFIX}${owner}:`
}

/**
 * Encrypted store for vendor agent credentials. Records are AES-GCM encrypted with a key derived
 * from `secret` (which must be a long random value) and bound to their owner and harness, so a
 * record copied to another slot does not decrypt.
 */
export function createCredentialStore(options: {
  readonly storage: CredentialStorage
  readonly secret: string | undefined
  readonly now?: () => number
}): CredentialStore {
  const { storage } = options
  const now = options.now ?? Date.now
  let cachedKey: Promise<CryptoKey> | undefined

  const key = (): Promise<CryptoKey> => {
    const secret = options.secret?.trim()

    if (!secret) {
      return Promise.reject(new CredentialsKeyMissingError())
    }

    cachedKey ??= crypto.subtle
      .digest('SHA-256', new TextEncoder().encode(secret))
      .then((digest) =>
        crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']),
      )

    return cachedKey
  }

  const slot = (owner: string, harness: VendorHarnessId) => {
    const storageKey = `${ownerPrefix(owner)}${harness}`

    return { storageKey, additionalData: new TextEncoder().encode(`${owner}:${harness}`) }
  }

  return {
    async put(owner, harness, payload) {
      const { storageKey, additionalData } = slot(owner, harness)
      const iv = crypto.getRandomValues(new Uint8Array(12))

      const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData },
        await key(),
        new TextEncoder().encode(JSON.stringify(payload)),
      )

      const record: StoredCredential = {
        v: 1,
        iv: toBase64(iv),
        data: toBase64(new Uint8Array(encrypted)),
        updatedAt: now(),
      }

      await storage.put(storageKey, record)
    },

    async get(owner, harness) {
      const { storageKey, additionalData } = slot(owner, harness)
      const record = await storage.get<StoredCredential>(storageKey)

      if (!record) {
        return null
      }

      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64(record.iv), additionalData },
        await key(),
        fromBase64(record.data),
      )

      return JSON.parse(new TextDecoder().decode(decrypted)) as CredentialPayload
    },

    async remove(owner, harness) {
      return storage.delete(slot(owner, harness).storageKey)
    },

    async list(owner) {
      const prefix = ownerPrefix(owner)
      const records = await storage.list<StoredCredential>({ prefix })
      const summaries: CredentialSummary[] = []

      for (const [storageKey, record] of records) {
        const harness = parseHarness(storageKey.slice(prefix.length))

        if (harness && harness !== 'shuttle') {
          summaries.push({ harness, updatedAt: record.updatedAt })
        }
      }

      return summaries
    },
  }
}

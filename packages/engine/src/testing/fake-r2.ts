interface Stored {
  readonly bytes: Uint8Array<ArrayBuffer>
  readonly httpMetadata?: R2HTTPMetadata
  readonly customMetadata?: Record<string, string>
}

type PutBody = ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null

async function bytesOf(body: PutBody): Promise<Uint8Array<ArrayBuffer>> {
  if (body instanceof ReadableStream) {
    return new Uint8Array(await new Response(body).arrayBuffer())
  }

  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body)
  }

  if (body instanceof Blob) {
    return new Uint8Array(await body.arrayBuffer())
  }

  if (ArrayBuffer.isView(body)) {
    return Uint8Array.from(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
  }

  return body === null ? new Uint8Array() : new TextEncoder().encode(body)
}

function parseRange(
  header: string | null,
  size: number,
): { offset: number; length: number } | null {
  const match = /^bytes=(\d+)-(\d*)$/.exec(header ?? '')

  if (!match) {
    return null
  }

  const offset = Number(match[1])
  const end = (match[2] ?? '') === '' ? size - 1 : Math.min(Number(match[2]), size - 1)

  return { offset, length: end - offset + 1 }
}

function describe(key: string, stored: Stored) {
  return {
    key,
    size: stored.bytes.byteLength,
    httpEtag: `"${key}"`,
    httpMetadata: stored.httpMetadata,
    customMetadata: stored.customMetadata,
  }
}

/** An in-memory R2 bucket with the parts of the API Shuttle uses. */
export function fakeBucket(): R2Bucket & { readonly keys: () => string[] } {
  const objects = new Map<string, Stored>()

  const bucket = {
    keys: () => [...objects.keys()],

    async put(key: string, body: PutBody, options?: R2PutOptions) {
      const stored: Stored = {
        bytes: await bytesOf(body),
        httpMetadata: options?.httpMetadata instanceof Headers ? undefined : options?.httpMetadata,
        customMetadata: options?.customMetadata,
      }

      objects.set(key, stored)

      return describe(key, stored)
    },

    async head(key: string) {
      const stored = objects.get(key)

      return stored ? describe(key, stored) : null
    },

    async get(key: string, options?: { range?: Headers }) {
      const stored = objects.get(key)

      if (!stored) {
        return null
      }

      const range = options?.range
        ? parseRange(options.range.get('range'), stored.bytes.byteLength)
        : null

      const bytes = range
        ? stored.bytes.slice(range.offset, range.offset + range.length)
        : stored.bytes

      return {
        ...describe(key, stored),
        range: range ?? undefined,
        body: new Blob([bytes]).stream(),
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      }
    },

    async delete(key: string) {
      objects.delete(key)
    },
  }

  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- SAFETY: the fake answers put, head, get, delete and keys, the whole R2 surface Shuttle's tests call; R2Bucket has more methods than a test needs to imitate.
  return bucket as unknown as R2Bucket & { readonly keys: () => string[] }
}

interface Stored {
  readonly bytes: Uint8Array
  readonly httpMetadata?: R2HTTPMetadata
  readonly customMetadata?: Record<string, string>
}

async function bytesOf(body: unknown): Promise<Uint8Array> {
  if (body instanceof ReadableStream) {
    return new Uint8Array(await new Response(body).arrayBuffer())
  }

  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body)
  }

  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  }

  return new TextEncoder().encode(String(body))
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
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1

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

    async put(key: string, body: unknown, options?: R2PutOptions) {
      const stored: Stored = {
        bytes: await bytesOf(body),
        httpMetadata: options?.httpMetadata as R2HTTPMetadata | undefined,
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
        ...(range ? { range } : {}),
        body: new Blob([bytes as Uint8Array<ArrayBuffer>]).stream(),
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      }
    },

    async delete(key: string) {
      objects.delete(key)
    },
  }

  return bucket as unknown as R2Bucket & { readonly keys: () => string[] }
}

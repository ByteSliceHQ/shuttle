const BLOCK = 512
const MAX_FILE_BYTES = 512 * 1024
const MAX_REPO_BYTES = 25 * 1024 * 1024

export interface TarEntry {
  readonly path: string
  readonly content: string
}

function readOctal(bytes: Uint8Array, start: number, length: number): number {
  let value = 0
  const end = start + length

  for (let index = start; index < end; index += 1) {
    const byte = bytes[index] ?? 0

    if (byte === 0 || byte === 32) {
      continue
    }

    if (byte < 48 || byte > 55) {
      break
    }

    value = value * 8 + (byte - 48)
  }

  return value
}

function readString(bytes: Uint8Array, start: number, length: number): string {
  let end = start

  while (end < start + length && bytes[end] !== 0) {
    end += 1
  }

  return new TextDecoder().decode(bytes.subarray(start, end))
}

function isBinary(bytes: Uint8Array): boolean {
  const sample = Math.min(bytes.length, 8000)

  for (let index = 0; index < sample; index += 1) {
    const byte = bytes[index]

    if (byte === 0) {
      return true
    }
  }

  return false
}

/**
 * Parse a ustar/pax tar archive (already gunzipped) into text file entries.
 * Skips binaries and files over {@link MAX_FILE_BYTES}; stops after {@link MAX_REPO_BYTES}.
 */
export function parseTar(buffer: ArrayBuffer): TarEntry[] {
  const bytes = new Uint8Array(buffer)
  const entries: TarEntry[] = []
  let offset = 0
  let totalBytes = 0
  let paxPath: string | null = null

  while (offset + BLOCK <= bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK)
    offset += BLOCK

    if (header.every((byte) => byte === 0)) {
      break
    }

    const size = readOctal(header, 124, 12)
    const typeFlag = header[156] ?? 0
    const name = readString(header, 0, 100)
    const prefix = readString(header, 345, 155)
    const headerPath = prefix === '' ? name : `${prefix}/${name}`
    const path = paxPath ?? headerPath
    paxPath = null

    const dataEnd = offset + size
    const data = bytes.subarray(offset, Math.min(dataEnd, bytes.length))
    offset = dataEnd + ((BLOCK - (size % BLOCK)) % BLOCK)

    // 'x' (112) or 'X' (88) = pax extended header; 'g' (103) = global pax.
    if (typeFlag === 120 || typeFlag === 88 || typeFlag === 103) {
      const text = new TextDecoder().decode(data)
      const match = text.match(/(?:^|\n)\d+ path=(.+?)(?:\n|$)/)

      if (match?.[1] !== undefined && typeFlag !== 103) {
        paxPath = match[1]
      }

      continue
    }

    // Regular files: '0' or NUL.
    if (typeFlag !== 0 && typeFlag !== 48) {
      continue
    }

    if (path === '' || path.endsWith('/') || size > MAX_FILE_BYTES || isBinary(data)) {
      continue
    }

    totalBytes += size

    if (totalBytes > MAX_REPO_BYTES) {
      break
    }

    entries.push({
      path,
      content: new TextDecoder().decode(data),
    })
  }

  return entries
}

/** Strip the GitHub tarball's leading `<owner>-<repo>-<sha>/` segment. */
export function stripTarRoot(path: string): string {
  const slash = path.indexOf('/')
  return slash >= 0 ? path.slice(slash + 1) : path
}

export { MAX_FILE_BYTES, MAX_REPO_BYTES }

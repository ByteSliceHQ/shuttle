import { describe, expect, test } from 'bun:test'

import { parseTar, stripTarRoot } from './tar'

function encodeOctal(value: number, length: number): Uint8Array {
  const text = value.toString(8).padStart(length - 1, '0') + '\0'
  return new TextEncoder().encode(text.slice(0, length))
}

function writeString(target: Uint8Array, offset: number, value: string, length: number) {
  const bytes = new TextEncoder().encode(value)
  target.set(bytes.slice(0, length), offset)
}

function checksum(header: Uint8Array): number {
  let sum = 0

  for (let index = 0; index < 512; index += 1) {
    sum += index >= 148 && index < 156 ? 32 : (header[index] ?? 0)
  }

  return sum
}

function makeTar(entries: { path: string; content: string; paxPath?: string }[]): ArrayBuffer {
  const blocks: Uint8Array[] = []

  for (const entry of entries) {
    if (entry.paxPath) {
      const paxBody = new TextEncoder().encode(`30 path=${entry.paxPath}\n`)
      const paxHeader = new Uint8Array(512)
      writeString(paxHeader, 0, './PaxHeader', 100)
      paxHeader.set(encodeOctal(paxBody.length, 12), 124)
      paxHeader[156] = 120 // 'x'
      writeString(paxHeader, 257, 'ustar', 6)
      const paxSum = checksum(paxHeader)
      paxHeader.set(encodeOctal(paxSum, 8), 148)
      blocks.push(paxHeader)

      const paxData = new Uint8Array(Math.ceil(paxBody.length / 512) * 512)
      paxData.set(paxBody)
      blocks.push(paxData)
    }

    const content = new TextEncoder().encode(entry.content)
    const header = new Uint8Array(512)
    writeString(header, 0, entry.path.slice(0, 100), 100)
    header.set(encodeOctal(content.length, 12), 124)
    header[156] = 48 // '0'
    writeString(header, 257, 'ustar', 6)
    const sum = checksum(header)
    header.set(encodeOctal(sum, 8), 148)
    blocks.push(header)

    const data = new Uint8Array(Math.ceil(content.length / 512) * 512 || 512)
    data.set(content)
    blocks.push(data)
  }

  blocks.push(new Uint8Array(1024))
  const total = blocks.reduce((sum, block) => sum + block.length, 0)
  const out = new Uint8Array(total)
  let offset = 0

  for (const block of blocks) {
    out.set(block, offset)
    offset += block.length
  }

  return out.buffer
}

describe('tar parser', () => {
  test('reads ustar entries and strips the github root', () => {
    const archive = makeTar([
      {
        path: 'byteslicehq-shuttle-abc123/src/index.ts',
        content: 'export const x = 1\n',
      },
      {
        path: 'byteslicehq-shuttle-abc123/README.md',
        content: '# Shuttle\n',
      },
    ])

    const entries = parseTar(archive)
    expect(entries).toHaveLength(2)
    expect(stripTarRoot(entries[0]!.path)).toBe('src/index.ts')
    expect(entries[0]!.content).toContain('export const x')
  })

  test('honors pax long paths', () => {
    const longPath = 'byteslicehq-shuttle-abc123/' + 'a'.repeat(120) + '/file.ts'

    const archive = makeTar([
      {
        path: 'short-name.ts',
        paxPath: longPath,
        content: 'ok\n',
      },
    ])

    const entries = parseTar(archive)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.path).toBe(longPath)
  })
})

import { describe, expect, test } from 'bun:test'

import {
  HARNESS_STORAGE_KEY,
  isVendorHarness,
  parseHarness,
  readStoredHarness,
  writeStoredHarness,
} from './harness'
import { memoryStorage } from './testing/memory-storage'

describe('parseHarness', () => {
  test('accepts built-in harnesses and named ACP agents', () => {
    expect(parseHarness('shuttle')).toBe('shuttle')
    expect(parseHarness(' codex ')).toBe('codex')
    expect(parseHarness('claude-code')).toBe('claude-code')
    expect(parseHarness('cursor')).toBe('cursor')
    expect(parseHarness('acp:gemini-cli')).toBe('acp:gemini-cli')
  })

  test('rejects unknown values', () => {
    expect(parseHarness('openai')).toBeNull()
    expect(parseHarness('acp:')).toBeNull()
    expect(parseHarness('acp:Bad Name')).toBeNull()
    expect(parseHarness('acp:../etc')).toBeNull()
    expect(parseHarness(undefined)).toBeNull()
  })
})

describe('isVendorHarness', () => {
  test('is false only for the built-in loop', () => {
    expect(isVendorHarness('shuttle')).toBe(false)
    expect(isVendorHarness('codex')).toBe(true)
    expect(isVendorHarness('acp:goose')).toBe(true)
  })
})

describe('stored harness', () => {
  test('defaults to shuttle when nothing valid is stored', async () => {
    expect(await readStoredHarness(memoryStorage())).toBe('shuttle')

    expect(await readStoredHarness(memoryStorage([[HARNESS_STORAGE_KEY, 'nope']]))).toBe('shuttle')
  })

  test('round-trips a valid harness and refuses an invalid one', async () => {
    const storage = memoryStorage()

    expect(await writeStoredHarness(storage, 'claude-code')).toBe('claude-code')
    expect(await readStoredHarness(storage)).toBe('claude-code')
    expect(writeStoredHarness(storage, 'bogus')).rejects.toThrow('unknown harness')
    expect(await readStoredHarness(storage)).toBe('claude-code')
  })
})

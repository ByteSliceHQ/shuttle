import { describe, expect, test } from 'bun:test'

import { matchesModelQuery } from './model-search'

const opus = ['Claude Opus 4.8 1M Max Thinking Fast', 'claude-4.8-opus-max-thinking-fast', '']

describe('matchesModelQuery', () => {
  test('an empty query matches everything', () => {
    expect(matchesModelQuery('', opus)).toBe(true)
    expect(matchesModelQuery('   ', opus)).toBe(true)
  })

  test('every word must appear, in any order and any case', () => {
    expect(matchesModelQuery('max opus', opus)).toBe(true)
    expect(matchesModelQuery('OPUS 4.8', opus)).toBe(true)
    expect(matchesModelQuery('opus sonnet', opus)).toBe(false)
  })

  test('matches ids typed with or without separators', () => {
    expect(matchesModelQuery('opus-max', opus)).toBe(true)
    expect(matchesModelQuery('gpt5', ['GPT-5.6 Sol', 'gpt-5.6-sol'])).toBe(true)
    expect(matchesModelQuery('4.8opus', opus)).toBe(true)
  })

  test('skips missing fields', () => {
    expect(matchesModelQuery('fast', ['Composer 2.5 Fast', undefined])).toBe(true)
    expect(matchesModelQuery('slow', ['Composer 2.5 Fast', undefined])).toBe(false)
  })
})

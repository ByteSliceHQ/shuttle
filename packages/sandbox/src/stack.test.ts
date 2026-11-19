import { describe, expect, test } from 'bun:test'

import { branchForLayer, parentBranchForLayer, parseLayerBranch } from './stack'

describe('stack branch naming', () => {
  test('stack 1 layer 1 keeps the legacy session branch', () => {
    expect(branchForLayer('session_1', 'glue', { stack: 1, layer: 1 })).toBe(
      'shuttle/session_1/glue',
    )
  })

  test('stack 1 layer 2+ uses the -stack suffix so refs cannot nest under layer 1', () => {
    expect(branchForLayer('session_1', 'glue', { stack: 1, layer: 3 })).toBe(
      'shuttle/session_1-stack/glue/3',
    )
  })

  test('stack 2+ numbers every layer, including layer 1', () => {
    expect(branchForLayer('session_1', 'glue', { stack: 2, layer: 1 })).toBe(
      'shuttle/session_1-stack2/glue/1',
    )

    expect(branchForLayer('session_1', 'glue', { stack: 12, layer: 4 })).toBe(
      'shuttle/session_1-stack12/glue/4',
    )
  })

  test('rejects non-positive addresses', () => {
    expect(() => branchForLayer('session_1', 'glue', { stack: 0, layer: 1 })).toThrow()
    expect(() => branchForLayer('session_1', 'glue', { stack: 1, layer: 0 })).toThrow()
  })

  test('parseLayerBranch round-trips every address', () => {
    for (const address of [
      { stack: 1, layer: 1 },
      { stack: 1, layer: 2 },
      { stack: 2, layer: 1 },
      { stack: 3, layer: 7 },
    ]) {
      const branch = branchForLayer('session_1', 'glue', address)
      expect(parseLayerBranch('session_1', 'glue', branch)).toEqual(address)
    }
  })

  test('parseLayerBranch ignores unrelated and non-canonical refs', () => {
    for (const branch of [
      'main',
      'shuttle/session_1/glue/2',
      'shuttle/session_1-stack/glue/1',
      'shuttle/session_1-stack1/glue/2',
      'shuttle/session_1-stack02/glue/1',
      'shuttle/session_1-stack2/glue/01',
      'shuttle/session_1-stack2/other/1',
      'shuttle/session_10-stack2/glue/1',
    ]) {
      expect(parseLayerBranch('session_1', 'glue', branch)).toBeNull()
    }
  })

  test('layer 1 of every stack is based on the default branch', () => {
    expect(parentBranchForLayer('session_1', 'glue', { stack: 2, layer: 1 }, 'main')).toBe('main')

    expect(parentBranchForLayer('session_1', 'glue', { stack: 2, layer: 2 }, 'main')).toBe(
      'shuttle/session_1-stack2/glue/1',
    )
  })
})

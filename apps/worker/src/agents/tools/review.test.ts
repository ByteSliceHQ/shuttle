import { describe, expect, test } from 'bun:test'

import { linesCoveredByPatch } from './review'

describe('linesCoveredByPatch', () => {
  test('parses unified diff hunks for the new file side', () => {
    const patch = ['@@ -1,3 +1,4 @@', ' keep', '-old', '+new', '+extra', ' trail'].join('\n')

    const lines = linesCoveredByPatch(patch)
    expect(lines.has(1)).toBe(true)
    expect(lines.has(2)).toBe(true)
    expect(lines.has(3)).toBe(true)
    expect(lines.has(4)).toBe(true)
  })

  test('returns empty set without a patch', () => {
    expect(linesCoveredByPatch(undefined).size).toBe(0)
  })
})

import { describe, expect, test } from 'bun:test'

import { bodyWithUnanchored, commentBody, linesCoveredByPatch, partitionByAnchor } from './review'

const PATCH = ['@@ -1,3 +1,4 @@', ' keep', '-old', '+new', '+extra', ' trail'].join('\n')

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

describe('linesCoveredByPatch on the old side', () => {
  test('covers removed and context lines by their old line numbers', () => {
    expect([...linesCoveredByPatch(PATCH, 'LEFT')]).toEqual([1, 2, 3])
  })
})

const at = (path: string, line: number, side: 'LEFT' | 'RIGHT' = 'RIGHT') => ({
  path,
  line,
  side,
  body: `note on ${path}:${line}`,
})

describe('partitionByAnchor', () => {
  const files = [{ path: 'app.js', patch: PATCH }, { path: 'logo.png' }]

  test('keeps comments on lines the diff shows, on either side', () => {
    const comments = [at('app.js', 4), at('app.js', 2, 'LEFT')]

    expect(partitionByAnchor(comments, files)).toEqual({ anchored: comments, unanchored: [] })
  })

  test('sets aside lines outside the hunks, files with no patch and files not in the diff', () => {
    const comments = [
      at('app.js', 40),
      at('app.js', 4, 'LEFT'),
      at('logo.png', 1),
      at('gone.js', 1),
    ]

    expect(partitionByAnchor(comments, files)).toEqual({ anchored: [], unanchored: comments })
  })
})

describe('review text', () => {
  test('comments that cannot be anchored are listed under the summary', () => {
    const body = bodyWithUnanchored('Looks good.', [
      { path: 'app.js', line: 40, side: 'RIGHT', body: 'Unused.' },
    ])

    expect(body).toContain('Looks good.')
    expect(body).toContain('`app.js:40` Unused.')
    expect(bodyWithUnanchored('Looks good.', [])).toBe('Looks good.')
  })

  test('a proposed replacement becomes a suggestion block', () => {
    expect(commentBody('Use const.', 'const a = 1')).toBe(
      'Use const.\n\n```suggestion\nconst a = 1\n```',
    )

    expect(commentBody('Use const.', undefined)).toBe('Use const.')
  })
})

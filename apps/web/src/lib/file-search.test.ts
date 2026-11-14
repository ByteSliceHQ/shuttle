import { describe, expect, test } from 'bun:test'

import { matchScore, searchFiles } from './file-search'

const paths = [
  'demo/README.md',
  'demo/package.json',
  'demo/src/app.ts',
  'demo/src/styles/app.css',
  'demo/src/components/session-share.tsx',
  'demo/src/lib/sandbox.ts',
  'demo/scripts/build.sh',
]

describe('searchFiles', () => {
  test('an empty query keeps every file, in path order', () => {
    expect(searchFiles(paths, '')).toEqual(
      paths.toSorted((left, right) => left.localeCompare(right)),
    )
  })

  test("letters in a file's name beat the same letters spread along the path", () => {
    expect(searchFiles(paths, 'app').slice(0, 2)).toEqual([
      'demo/src/app.ts',
      'demo/src/styles/app.css',
    ])
  })

  test('initials of the words in a name find it', () => {
    expect(searchFiles(paths, 'ssh')[0]).toBe('demo/src/components/session-share.tsx')
  })

  test('case and spaces in the query do not matter', () => {
    expect(searchFiles(paths, 'READ me')[0]).toBe('demo/README.md')
  })

  test('letters must appear in order', () => {
    expect(matchScore('tsapp', 'demo/src/app.ts')).toBeNull()
    expect(searchFiles(paths, 'zzz')).toEqual([])
  })

  test('folders narrow a search', () => {
    expect(searchFiles(paths, 'lib sand')).toEqual(['demo/src/lib/sandbox.ts'])
  })

  test('results are capped', () => {
    expect(searchFiles(paths, '', 3)).toHaveLength(3)
  })
})

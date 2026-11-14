import { describe, expect, test } from 'bun:test'

import { anchorsIn, reviewFiles } from './review-diff'

const DIFF = [
  'diff --git a/app.js b/app.js',
  'index 111..222 100644',
  '--- a/app.js',
  '+++ b/app.js',
  '@@ -1,3 +1,4 @@',
  ' keep',
  '-old',
  '+new',
  '+extra',
  ' trail',
  'diff --git a/gone.js b/gone.js',
  'deleted file mode 100644',
  '--- a/gone.js',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-one',
  '-two',
  '',
].join('\n')

describe('reviewFiles', () => {
  test('cuts a diff into one patch per file, naming deleted files by their old path', () => {
    const files = reviewFiles(DIFF)

    expect(files.map((file) => file.path)).toEqual(['app.js', 'gone.js'])
    expect(files[0]?.patch.startsWith('diff --git a/app.js')).toBe(true)
    expect(files[0]?.patch).not.toContain('gone.js')

    expect(files.map((file) => [file.additions, file.deletions])).toEqual([
      [2, 1],
      [0, 2],
    ])
  })

  test('knows which lines a comment can sit on, on each side', () => {
    const [app] = reviewFiles(DIFF)

    expect(anchorsIn(app!, 'RIGHT', 4)).toBe(true)
    expect(anchorsIn(app!, 'LEFT', 2)).toBe(true)
    expect(anchorsIn(app!, 'RIGHT', 40)).toBe(false)
    expect(anchorsIn(app!, 'LEFT', 4)).toBe(false)
    expect(anchorsIn(app!, 'RIGHT', null)).toBe(false)
  })

  test('an empty diff has no files', () => {
    expect(reviewFiles('')).toEqual([])
  })
})

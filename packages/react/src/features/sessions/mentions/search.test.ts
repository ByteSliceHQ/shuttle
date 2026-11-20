import { describe, expect, test } from 'bun:test'

import {
  PathIndex,
  findMentionQuery,
  insertMention,
  matchesLabel,
  scoreLabel,
  scorePath,
  sessionLabel,
} from './search'

describe('findMentionQuery', () => {
  test('finds an @ at the start or after a space, up to the caret', () => {
    expect(findMentionQuery('@ap', 3)).toEqual({ start: 0, query: 'ap' })
    expect(findMentionQuery('look at @src/a', 14)).toEqual({ start: 8, query: 'src/a' })
    expect(findMentionQuery('line\n@', 6)).toEqual({ start: 5, query: '' })
  })

  test('keeps going over single spaces, so a title can be searched by several words', () => {
    expect(findMentionQuery('see @simple todo', 16)).toEqual({ start: 4, query: 'simple todo' })
  })

  test('ignores an email address, and stops at a line break, two spaces or a space after @', () => {
    expect(findMentionQuery('mail a@b.co', 11)).toBeNull()
    expect(findMentionQuery('@done\nmore', 10)).toBeNull()
    expect(findMentionQuery('@done  more', 11)).toBeNull()
    expect(findMentionQuery('@ more', 6)).toBeNull()
    expect(findMentionQuery('no mention', 10)).toBeNull()
  })
})

describe('insertMention', () => {
  test('replaces what was typed and leaves the caret after a space', () => {
    expect(insertMention('see @ap now', { start: 4, query: 'ap' }, '@web/app.ts')).toEqual({
      text: 'see @web/app.ts now',
      caret: 16,
    })

    expect(insertMention('@ap', { start: 0, query: 'ap' }, '@web/app.ts')).toEqual({
      text: '@web/app.ts ',
      caret: 12,
    })
  })
})

describe('scorePath', () => {
  test('ranks a name match over a folder match over scattered letters', () => {
    const name = scorePath('composer', 'packages/react/src/composer.tsx')
    const folder = scorePath('composer', 'packages/composer/src/index.ts')
    const scattered = scorePath('cmpsr', 'packages/react/src/composer.tsx')

    expect(name).toBeGreaterThan(folder)
    expect(folder).toBeGreaterThan(scattered)
    expect(scattered).toBeGreaterThan(0)
  })

  test('refuses letters out of order', () => {
    expect(scorePath('zx', 'xz.ts')).toBe(-1)
  })
})

describe('PathIndex', () => {
  const index = new PathIndex([
    'web/src/App.tsx',
    'web/src/app.css',
    'api/src/apply.ts',
    'web/README.md',
  ])

  test('returns the best matches first, keeping the case of each path and list order on a tie', () => {
    expect(index.search('app', 2).map((match) => match.path)).toEqual([
      'web/src/App.tsx',
      'web/src/app.css',
    ])
  })

  test('narrows as more is typed, and widens again when it is deleted', () => {
    expect(index.search('app', 10)).toHaveLength(3)
    expect(index.search('appl', 10).map((match) => match.path)).toEqual(['api/src/apply.ts'])
    expect(index.search('rea', 10).map((match) => match.path)).toEqual(['web/README.md'])
  })

  test('searches 100k paths in well under a frame', () => {
    const big = new PathIndex(
      Array.from(
        { length: 100_000 },
        (_, i) => `packages/p${i % 300}/src/feature-${i}/file${i}.ts`,
      ),
    )

    const started = performance.now()
    big.search('f', 50)
    big.search('fe', 50)
    big.search('fea', 50)
    big.search('feat', 50)
    const elapsed = performance.now() - started

    expect(elapsed).toBeLessThan(500)
  })
})

describe('matchesLabel', () => {
  test('matches everything for an empty query, the text as written, or word initials', () => {
    expect(matchesLabel('', 'Codex')).toBe(true)
    expect(matchesLabel('ode', 'Codex')).toBe(true)
    expect(matchesLabel('bta', 'Build a todo app')).toBe(true)
    expect(matchesLabel('TODO', 'Build a todo app')).toBe(true)
  })

  test('does not match letters scattered across a sentence', () => {
    expect(matchesLabel('read', 'create a todo app and then create a PR')).toBe(false)
    expect(matchesLabel('cdx', 'Codex')).toBe(false)
  })
})

describe('scoreLabel', () => {
  test('ranks the title itself, then its start, then a word in it, then letters inside a word', () => {
    const scores = ['todo', 'todo app', 'build a todo app', 'mastodon'].map((label) =>
      scoreLabel('todo', label),
    )

    expect(scores).toEqual(scores.toSorted((a, b) => b - a))
    expect(scoreLabel('bta', 'Build a todo app')).toBeGreaterThan(0)

    expect(scoreLabel('todo', 'Build a todo app')).toBeGreaterThan(
      scoreLabel('bta', 'Build a todo app'),
    )
  })
})

describe('PathIndex keeping only the best', () => {
  test('returns the same best matches as sorting them all would', () => {
    const paths = Array.from({ length: 500 }, (_, i) => `src/f${(i * 7919) % 500}/a${i}.ts`)
    const index = new PathIndex(paths)

    const expected = paths
      .map((path, at) => ({ path, at, score: scorePath('a1', path.toLowerCase()) }))
      .filter((match) => match.score >= 0)
      .toSorted((a, b) => b.score - a.score || a.at - b.at)
      .slice(0, 10)
      .map((match) => match.path)

    expect(index.search('a1', 10).map((match) => match.path)).toEqual(expected)
  })
})

describe('sessionLabel', () => {
  test('is the title, or the first line of the goal, cut short', () => {
    expect(sessionLabel('Fix login', 'anything')).toBe('Fix login')
    expect(sessionLabel('', 'two apps.\n\neach a separate PR')).toBe('two apps.')
    expect(sessionLabel('', 'x'.repeat(200))).toBe(`${'x'.repeat(79)}…`)
  })
})

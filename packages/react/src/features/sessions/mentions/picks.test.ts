import { describe, expect, test } from 'bun:test'

import { labelsInUse, pickOf, picksIn } from './picks'

const first = pickOf({ kind: 'session', sessionId: 's1', title: 'todo app', label: 'todo app' })

const second = pickOf({
  kind: 'session',
  sessionId: 's2',
  title: 'todo app',
  label: 'todo app (2)',
})

const readme = pickOf({ kind: 'file', path: 'demo/README.md' })

describe('picksIn', () => {
  test('keeps the picks whose text is still there, once each', () => {
    expect(picksIn('@demo/README.md and @demo/README.md', [readme, readme])).toEqual([readme])
  })

  test('does not count a pick whose text is only part of a longer one', () => {
    expect(picksIn('only @todo app (2) is left', [first, second])).toEqual([second])
  })
})

describe('labelsInUse', () => {
  test('lists how each pick still in the text is written', () => {
    expect(labelsInUse('@todo app and @demo/README.md', [first, second, readme])).toEqual([
      { label: 'todo app', identity: 'session:s1' },
      { label: 'demo/README.md', identity: 'file:demo/README.md' },
    ])
  })
})

describe('pickOf', () => {
  test('sends a session with the text it is written as', () => {
    expect(pickOf({ kind: 'session', sessionId: 's3', title: 'calc' }).input).toEqual({
      kind: 'session',
      sessionId: 's3',
      label: 'calc',
    })
  })
})

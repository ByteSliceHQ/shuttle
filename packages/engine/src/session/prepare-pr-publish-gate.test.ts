import { describe, expect, test } from 'bun:test'

import { publishedRepositories, publishQuestion } from './prepare-pr-publish-gate'

describe('publishQuestion', () => {
  test('asks to publish when the layer has no pull request yet', () => {
    const question = publishQuestion(null)

    expect(question.title).toBe('Publish pull requests?')
    expect(question.actions.map((action) => action.id)).toEqual(['draft', 'publish', 'discard'])
  })

  test('asks to update the pull request the layer already has', () => {
    const question = publishQuestion('ByteSliceHQ/demo#13')

    expect(question.title).toBe('Update ByteSliceHQ/demo#13?')
    expect(question.actions.map((action) => action.id)).toEqual(['update', 'discard'])
  })
})

describe('publishedRepositories', () => {
  const linked = [
    { name: 'shop', fullName: 'acme/shop' },
    { name: 'docs', fullName: 'acme/docs' },
  ]

  test("is the proposing layer's repository when the proposal names one", () => {
    expect(publishedRepositories(linked, 'shop', ['docs'])).toEqual(['acme/shop'])
  })

  test('is the repositories the proposal lists, by full name', () => {
    expect(publishedRepositories(linked, null, ['docs', 'acme/shop'])).toEqual([
      'acme/docs',
      'acme/shop',
    ])
  })

  test('is every linked repository when the proposal names none', () => {
    expect(publishedRepositories(linked, null, [])).toEqual(['acme/shop', 'acme/docs'])
  })

  test('keeps a name the session has no repository for', () => {
    expect(publishedRepositories(linked, 'other', [])).toEqual(['other'])
  })
})

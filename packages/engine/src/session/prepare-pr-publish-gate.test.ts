import { describe, expect, test } from 'bun:test'

import { publishQuestion } from './prepare-pr-publish-gate'

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

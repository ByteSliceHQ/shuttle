import { describe, expect, test } from 'bun:test'

import { GithubGraphqlError } from '../github/client'
import { classifySyncError, missingPullPermissions } from './folder-sync'

describe('missingPullPermissions', () => {
  test('lists every inbox permission an install lacks', () => {
    expect(missingPullPermissions({ contents: 'write', metadata: 'read' })).toEqual([
      'Pull requests',
      'Checks',
      'Commit statuses',
    ])
  })

  test('is empty once read access is granted', () => {
    expect(
      missingPullPermissions({ pull_requests: 'write', checks: 'read', statuses: 'read' }),
    ).toEqual([])
  })
})

describe('classifySyncError', () => {
  test('treats FORBIDDEN GraphQL errors as a permission problem', () => {
    const error = new GithubGraphqlError('nope', ['FORBIDDEN'], null)
    expect(classifySyncError(error).status).toBe('forbidden')
  })

  test('recognizes the integration access message without a type', () => {
    const error = new Error('GitHub GraphQL errors: Resource not accessible by integration')
    expect(classifySyncError(error).status).toBe('forbidden')
  })

  test('keeps other failures verbatim', () => {
    expect(classifySyncError(new Error('GitHub GraphQL failed: 502'))).toEqual({
      status: 'failed',
      message: 'GitHub GraphQL failed: 502',
    })
  })
})

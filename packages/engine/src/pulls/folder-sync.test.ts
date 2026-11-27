import { describe, expect, test } from 'bun:test'

import { GithubGraphqlError } from '@shuttle/git/github/client'

import { classifySyncError, missingPullPermissions, alreadyRecorded } from './folder-sync'

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

const fetched = {
  installationId: 1,
  fullName: 'acme/api',
  number: 7,
  title: 'First',
  body: 'the whole body',
  url: 'https://github.com/acme/api/pull/7',
  state: 'open' as const,
  draft: false,
  authorLogin: 'dylan',
  authorAvatarUrl: 'https://example.test/dylan.png',
  headRef: 'feature',
  headSha: 'aaa',
  baseRef: 'main',
  baseSha: 'bbb',
  additions: 1,
  deletions: 0,
  reviewDecision: 'none' as const,
  checkRollup: 'pending' as const,
  updatedAt: 100,
  isFork: false,
  stack: null,
}

const mirrored = {
  installationId: 1,
  fullName: 'acme/api',
  number: 7,
  title: 'First',
  body: 'the whole body',
  url: 'https://github.com/acme/api/pull/7',
  state: 'open' as const,
  draft: false,
  author: { login: 'dylan', avatarUrl: 'https://example.test/dylan.png' },
  headRef: 'feature',
  headSha: 'aaa',
  baseRef: 'main',
  baseSha: 'bbb',
  additions: 1,
  deletions: 0,
  reviewDecision: 'none' as const,
  checkRollup: 'pending' as const,
  updatedAt: 100,
  isFork: false,
  stack: null,
  linkedSessions: [],
  reviewingRunId: null,
}

describe('alreadyRecorded', () => {
  test('matches a fetched pull request to the copy the inbox mirrors', () => {
    expect(alreadyRecorded(mirrored, fetched)).toBe(true)
  })

  test('records a fetched pull request that changed', () => {
    expect(alreadyRecorded(mirrored, { ...fetched, body: 'rewritten' })).toBe(false)
    expect(alreadyRecorded(mirrored, { ...fetched, headSha: 'ccc', updatedAt: 200 })).toBe(false)
    expect(alreadyRecorded(mirrored, { ...fetched, checkRollup: 'passing' })).toBe(false)
    expect(alreadyRecorded(mirrored, { ...fetched, baseRef: 'release' })).toBe(false)
  })

  test('skips a copy that a checks event made newer than the fetch', () => {
    const newerMirror = { ...mirrored, updatedAt: 500 }

    expect(alreadyRecorded(newerMirror, fetched)).toBe(true)
    expect(alreadyRecorded(newerMirror, { ...fetched, checkRollup: 'passing' })).toBe(true)
  })

  test('records a pull request the inbox has never seen', () => {
    expect(alreadyRecorded(undefined, fetched)).toBe(false)
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

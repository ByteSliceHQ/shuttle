import { describe, expect, test } from 'bun:test'

import { personalWorkspaceRunId, workspaceRunId } from '../config'
import { fakeEnv } from '../testing/fake-env'
import { listingChanges, listingRunIds } from './listings'

const env = fakeEnv()
const ORG = 'orgA0000000000000000000000000000'
const shared = workspaceRunId(env, ORG)
const of = (userId: string) => personalWorkspaceRunId(env, ORG, userId)

const access = (memberIds: string[], visibility: 'private' | 'public' = 'private') => ({
  ownerId: 'alice',
  memberIds,
  visibility,
})

describe('listingRunIds', () => {
  test('a private session is listed only for its owner and members', () => {
    expect(listingRunIds(env, ORG, access([]))).toEqual([of('alice')])
    expect(listingRunIds(env, ORG, access(['bob']))).toEqual([of('alice'), of('bob')])
  })

  test('a public session, or one Shuttle started, is listed for the organization', () => {
    expect(listingRunIds(env, ORG, access(['bob'], 'public'))).toEqual([shared])
    expect(listingRunIds(env, ORG, null)).toEqual([shared])

    expect(listingRunIds(env, ORG, { ownerId: null, memberIds: [], visibility: 'public' })).toEqual(
      [shared],
    )
  })
})

describe('listingChanges', () => {
  test('sharing adds the new member and keeps the owner', () => {
    expect(listingChanges(env, ORG, access([]), access(['bob']))).toEqual({
      added: [of('bob')],
      removed: [],
      kept: [of('alice')],
    })
  })

  test('unsharing removes the member', () => {
    expect(listingChanges(env, ORG, access(['bob']), access([]))).toEqual({
      added: [],
      removed: [of('bob')],
      kept: [of('alice')],
    })
  })

  test('going public moves the session to the organization, and back again', () => {
    expect(listingChanges(env, ORG, access(['bob']), access(['bob'], 'public'))).toEqual({
      added: [shared],
      removed: [of('alice'), of('bob')],
      kept: [],
    })

    expect(listingChanges(env, ORG, access(['bob'], 'public'), access(['bob']))).toEqual({
      added: [of('alice'), of('bob')],
      removed: [shared],
      kept: [],
    })
  })
})

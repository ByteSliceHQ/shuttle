import { afterEach, describe, expect, test } from 'bun:test'

import type { ShuttleEnv } from '../env'
import { fakeEnv } from '../testing/fake-env'
import { commitIdentityOf } from './commit-identity'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

/** An auth database whose `account` table holds these GitHub account ids, by user. */
function envWith(githubAccounts: Readonly<Record<string, string>>): ShuttleEnv {
  const db = {
    prepare: () => ({
      bind: (userId: string) => ({
        first: async () => {
          const accountId = githubAccounts[userId]

          return accountId === undefined ? null : { accountId }
        },
      }),
    }),
  }

  // SAFETY: the lookup calls only `prepare().bind().first()`, which this fake implements.
  return fakeEnv({ AUTH_DB: db as never })
}

/** What GitHub says about an account: a profile, or an error message. */
type GithubAnswer =
  | { readonly id: number; readonly login: string; readonly name: string | null }
  | { readonly message: string }

/** GitHub answers `/user/:id` with this, and records what was asked. */
function githubAnswers(status: number, profile: GithubAnswer): string[] {
  const asked: string[] = []

  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      asked.push(input instanceof Request ? input.url : input.toString())

      return Response.json(profile, { status })
    },
    { preconnect: realFetch.preconnect },
  )

  return asked
}

describe('commitIdentityOf', () => {
  test("is the person's GitHub name and no-reply address", async () => {
    const asked = githubAnswers(200, { id: 42, login: 'electric-gizzard', name: 'J. Eric' })

    expect(await commitIdentityOf(envWith({ user_1: '42' }), 'user_1', 'token')).toEqual({
      name: 'J. Eric',
      email: '42+electric-gizzard@users.noreply.github.com',
    })

    expect(asked).toEqual(['https://api.github.com/user/42'])
  })

  test('falls back to the login when the profile has no name', async () => {
    githubAnswers(200, { id: 42, login: 'electric-gizzard', name: null })

    const identity = await commitIdentityOf(envWith({ user_1: '42' }), 'user_1', 'token')

    expect(identity?.name).toBe('electric-gizzard')
  })

  test('is null for someone with no GitHub account linked', async () => {
    const asked = githubAnswers(200, { message: 'unused' })

    expect(await commitIdentityOf(envWith({}), 'user_1', 'token')).toBeNull()
    expect(asked).toEqual([])
  })

  test('is null when GitHub cannot say who the account is', async () => {
    githubAnswers(404, { message: 'Not Found' })

    expect(await commitIdentityOf(envWith({ user_1: '42' }), 'user_1', 'token')).toBeNull()
  })
})

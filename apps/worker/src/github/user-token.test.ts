import { describe, expect, test } from 'bun:test'

import { githubTokenOf, type GithubTokenSource } from './user-token'

/** An auth instance that knows these accounts and hands out `token` for the GitHub one. */
function authWith(
  accounts: readonly { id: string; providerId: string }[],
  token: () => Promise<{ accessToken: string }>,
) {
  const asked: string[] = []

  const auth: GithubTokenSource = {
    api: {
      listUserAccounts: async () => accounts,
      getAccessToken: async ({ body }: { body: { accountId: string } }) => {
        asked.push(body.accountId)

        return token()
      },
    },
  }

  return { auth, asked }
}

const headers = new Headers()

describe('githubTokenOf', () => {
  test("is the token of the person's GitHub account, not of another sign-in they have", async () => {
    const { auth, asked } = authWith(
      [
        { id: 'acc_email', providerId: 'credential' },
        { id: 'acc_github', providerId: 'github' },
      ],
      async () => ({ accessToken: 'ghu_person' }),
    )

    expect(await githubTokenOf(auth, headers)).toBe('ghu_person')
    expect(asked).toEqual(['acc_github'])
  })

  test('is null for someone who has not connected GitHub', async () => {
    const { auth, asked } = authWith([{ id: 'acc_email', providerId: 'credential' }], async () => ({
      accessToken: 'unused',
    }))

    expect(await githubTokenOf(auth, headers)).toBeNull()
    expect(asked).toEqual([])
  })

  test('is null when GitHub will no longer renew the token', async () => {
    const { auth } = authWith([{ id: 'acc_github', providerId: 'github' }], async () => {
      throw new Error('refresh token expired')
    })

    expect(await githubTokenOf(auth, headers)).toBeNull()
  })
})

import { describe, expect, test } from 'bun:test'

import { fixedGitAccess } from './access'
import { getInstallationToken, githubUserToken } from './github/client'
import { fakeEnv } from './testing/fake-env'

/** What a call rejects with; fails the test when the call succeeds. */
async function rejection(call: Promise<unknown>): Promise<Error> {
  try {
    await call
  } catch (error) {
    if (error instanceof Error) {
      return error
    }

    throw error
  }

  throw new Error('expected the call to fail')
}

describe('Git access port', () => {
  test('installation tokens come from the host when it supplies access', async () => {
    const env = fakeEnv({ GIT_ACCESS: fixedGitAccess('host-token') })

    expect(await getInstallationToken(env, 42)).toBe('host-token')
  })

  test('a host that does not supply a user token has none, whatever GITHUB_TOKEN says', () => {
    const env = fakeEnv({
      GITHUB_TOKEN: 'pat',
      GIT_ACCESS: { installationToken: async () => 'host-token' },
    })

    expect(githubUserToken(env)).toBeNull()
  })

  test('without a port the user token is the one configured', () => {
    expect(githubUserToken(fakeEnv({ GITHUB_TOKEN: ' pat ' }))).toBe('pat')
    expect(githubUserToken(fakeEnv())).toBeNull()
  })

  test('without a port and without an App, minting an installation token fails clearly', async () => {
    const error = await rejection(getInstallationToken(fakeEnv(), 42))

    expect(error.message).toContain('GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required')
  })
})

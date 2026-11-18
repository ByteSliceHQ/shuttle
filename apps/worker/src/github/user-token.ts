/** The part of the auth instance that holds a person's linked accounts and their tokens. */
export interface GithubTokenSource {
  readonly api: {
    listUserAccounts(input: {
      headers: Headers
    }): Promise<readonly { readonly id: string; readonly providerId: string }[]>
    getAccessToken(input: {
      body: { accountId: string }
      headers: Headers
    }): Promise<{ readonly accessToken: string }>
  }
}

/**
 * The GitHub token that acts as the signed-in person, for what they say on GitHub in their own
 * name: replies, comments, resolving a thread. Better Auth keeps it for anyone who signed in
 * with GitHub or linked their GitHub account, and renews it when it has expired.
 *
 * Null when the person has no GitHub account connected, or GitHub will no longer renew the one
 * they had. Either way the answer is for them to connect it again.
 */
export async function githubTokenOf(
  auth: GithubTokenSource,
  headers: Headers,
): Promise<string | null> {
  try {
    const accounts = await auth.api.listUserAccounts({ headers })
    const account = accounts.find((item) => item.providerId === 'github')

    if (!account) {
      return null
    }

    const tokens = await auth.api.getAccessToken({ body: { accountId: account.id }, headers })

    return tokens.accessToken === '' ? null : tokens.accessToken
  } catch {
    return null
  }
}

/** What a route answers when someone has to connect GitHub before it can act as them. */
export const GITHUB_NOT_CONNECTED = 'github_not_connected'

import { z } from 'zod'

import type { ShuttleEnv } from '../env'
import { connectInstallation } from '../tenancy/installations'
import type { GithubAccount } from './client'

/**
 * Linking a GitHub App installation to a Shuttle organization by proving who is asking.
 *
 * The App's own credentials can read every installation, so an installation id from a URL proves
 * nothing about the person presenting it. Instead the person signs in to GitHub, and GitHub says
 * which installations of this App they can access. Only those can be linked.
 *
 * This also covers an App that is already installed: GitHub does not call Shuttle back for an
 * existing installation, but it does list it here.
 */

type OAuthEnv = Pick<
  ShuttleEnv,
  'GITHUB_CLIENT_ID' | 'GITHUB_CLIENT_SECRET' | 'GITHUB_APP_ID' | 'SHUTTLE_WEB_URL'
>

export interface AccessibleInstallation {
  readonly id: number
  readonly account: GithubAccount
}

export type LinkOutcome =
  /** These installations are now connected to this organization. */
  | { readonly kind: 'linked'; readonly installations: readonly AccessibleInstallation[] }
  /** The App is not installed anywhere the person can reach. */
  | { readonly kind: 'none' }

export function githubOAuthConfigured(env: OAuthEnv): boolean {
  return (
    (env.GITHUB_CLIENT_ID?.trim() ?? '') !== '' && (env.GITHUB_CLIENT_SECRET?.trim() ?? '') !== ''
  )
}

/** Where GitHub sends the person back to. It must be listed as a callback URL on the App. */
export function githubCallbackUrl(env: OAuthEnv): string {
  return `${env.SHUTTLE_WEB_URL ?? 'http://127.0.0.1:5180'}/github/callback`
}

/** The GitHub page that asks the person to identify themselves to the App. */
export function githubAuthorizeUrl(env: OAuthEnv, state: string): string {
  const url = new URL('https://github.com/login/oauth/authorize')

  url.searchParams.set('client_id', env.GITHUB_CLIENT_ID?.trim() ?? '')
  url.searchParams.set('redirect_uri', githubCallbackUrl(env))
  url.searchParams.set('state', state)

  return url.toString()
}

/** Trades the code GitHub sent back for a token that acts as the person. */
export async function exchangeGithubCode(
  env: OAuthEnv,
  code: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const response = await fetcher('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID?.trim(),
      client_secret: env.GITHUB_CLIENT_SECRET?.trim(),
      code,
      redirect_uri: githubCallbackUrl(env),
    }),
  })

  const body = TokenExchangeSchema.parse(await response.json().catch(() => null))

  if (!response.ok || body?.access_token === undefined) {
    throw new Error(
      body?.error_description ?? `GitHub did not accept the sign-in (${response.status})`,
    )
  }

  return body.access_token
}

/** Fields that are not the expected kind read as absent. */
const TokenExchangeSchema = z
  .object({
    access_token: z.string().optional().catch(undefined),
    error_description: z.string().optional().catch(undefined),
  })
  .nullable()
  .catch(null)

const InstallationsPageSchema = z.object({
  installations: z
    .array(
      z.object({
        id: z.number().optional().catch(undefined),
        app_id: z.number().optional().catch(undefined),
        account: z
          .object({
            login: z.string().optional().catch(undefined),
            type: z.string().optional().catch(undefined),
            avatar_url: z.string().optional().catch(undefined),
          })
          .nullish()
          .catch(undefined),
      }),
    )
    .optional()
    .default([]),
})

/** The installations of this App that the person can access, as GitHub reports them. */
export async function listAccessibleInstallations(
  env: OAuthEnv,
  userToken: string,
  fetcher: typeof fetch = fetch,
): Promise<AccessibleInstallation[]> {
  const found: AccessibleInstallation[] = []
  const appId = Number(env.GITHUB_APP_ID)

  for (let page = 1; page <= 10; page += 1) {
    const response = await fetcher(
      `https://api.github.com/user/installations?per_page=100&page=${page}`,
      {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${userToken}`,
          'user-agent': 'shuttle',
          'x-github-api-version': '2022-11-28',
        },
      },
    )

    if (!response.ok) {
      throw new Error(`GitHub would not list installations (${response.status})`)
    }

    const { installations } = InstallationsPageSchema.parse(await response.json())

    for (const installation of installations) {
      const { id, account } = installation

      // A token for this App only ever lists this App's installations; the check is a guard.
      if (
        id === undefined ||
        (Number.isFinite(appId) && installation.app_id !== appId) ||
        account?.login === undefined
      ) {
        continue
      }

      found.push({
        id,
        account: {
          login: account.login,
          type: account.type ?? 'User',
          avatarUrl: account.avatar_url ?? '',
        },
      })
    }

    if (installations.length < 100) {
      break
    }
  }

  return found
}

/**
 * Connects `orgId` to every installation in `accessible`, which GitHub has said the person can
 * access. Other organizations connected to the same installations keep them.
 */
export async function linkInstallations(
  db: D1Database,
  orgId: string,
  accessible: readonly AccessibleInstallation[],
): Promise<LinkOutcome> {
  if (accessible.length === 0) {
    return { kind: 'none' }
  }

  for (const installation of accessible) {
    await connectInstallation(db, installation.id, orgId)
  }

  return { kind: 'linked', installations: accessible }
}

import { describe, expect, test } from 'bun:test'

import { orgsOfInstallation } from '../tenancy/installations'
import { migratedD1 } from '../testing/fake-d1'
import {
  exchangeGithubCode,
  githubAuthorizeUrl,
  githubCallbackUrl,
  githubOAuthConfigured,
  linkInstallations,
  listAccessibleInstallations,
} from './user-link'

const env = {
  GITHUB_CLIENT_ID: 'client-id',
  GITHUB_CLIENT_SECRET: 'client-secret',
  GITHUB_APP_ID: '42',
  SHUTTLE_WEB_URL: 'https://shuttle.example.com',
}

const account = { login: 'acme', type: 'Organization', avatarUrl: '' }
const acme = { id: 1, account }
const other = { id: 2, account: { ...account, login: 'other' } }

/** A fetch that answers from a list of canned responses and records what it was asked. */
function cannedFetch(responses: readonly { status?: number; body: unknown }[]) {
  const requests: { url: string; headers: Headers; body: string | null }[] = []
  let next = 0

  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
    })

    const response = responses[next] ?? { status: 500, body: {} }
    next += 1

    return Response.json(response.body, { status: response.status ?? 200 })
  }) as typeof fetch

  return { fetcher, requests }
}

describe('github sign-in for linking', () => {
  test('is used only when the App has an OAuth client', () => {
    expect(githubOAuthConfigured(env)).toBe(true)
    expect(githubOAuthConfigured({ ...env, GITHUB_CLIENT_SECRET: ' ' })).toBe(false)
    expect(githubOAuthConfigured({})).toBe(false)
  })

  test('sends the person to GitHub and back to the web app', () => {
    const url = new URL(githubAuthorizeUrl(env, 'signed-state'))

    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('client-id')
    expect(url.searchParams.get('state')).toBe('signed-state')
    expect(url.searchParams.get('redirect_uri')).toBe(githubCallbackUrl(env))
    expect(githubCallbackUrl(env)).toBe('https://shuttle.example.com/github/callback')
  })

  test('trades the code for a token that acts as the person', async () => {
    const { fetcher, requests } = cannedFetch([{ body: { access_token: 'user-token' } }])

    expect(await exchangeGithubCode(env, 'the-code', fetcher)).toBe('user-token')

    expect(JSON.parse(requests[0]?.body ?? '{}')).toMatchObject({
      client_id: 'client-id',
      client_secret: 'client-secret',
      code: 'the-code',
    })
  })

  test('a code GitHub refuses is an error, with its reason', async () => {
    const { fetcher } = cannedFetch([
      { body: { error: 'bad_verification_code', error_description: 'The code has expired.' } },
    ])

    await expect(exchangeGithubCode(env, 'stale', fetcher)).rejects.toThrow('The code has expired.')
  })
})

describe('listAccessibleInstallations', () => {
  test("lists this App's installations the person can access, as the person", async () => {
    const { fetcher, requests } = cannedFetch([
      {
        body: {
          installations: [
            { id: 1, app_id: 42, account: { login: 'acme', type: 'Organization' } },
            // Another App's installation is never linked, whatever GitHub returns.
            { id: 9, app_id: 7, account: { login: 'elsewhere', type: 'User' } },
          ],
        },
      },
    ])

    expect(await listAccessibleInstallations(env, 'user-token', fetcher)).toEqual([acme])
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer user-token')
    expect(requests[0]?.url).toContain('/user/installations')
  })

  test('a refusal from GitHub is an error, not an empty list', async () => {
    const { fetcher } = cannedFetch([{ status: 401, body: {} }])

    await expect(listAccessibleInstallations(env, 'bad', fetcher)).rejects.toThrow('401')
  })
})

describe('linkInstallations', () => {
  test('an existing installation the person can access is linked to their organization', async () => {
    const db = await migratedD1()

    expect(await linkInstallations(db, 'orgA', [acme, other])).toEqual({
      kind: 'linked',
      installations: [acme, other],
    })

    expect(await orgsOfInstallation(db, 1)).toEqual(['orgA'])
    // Linking again is harmless.
    expect((await linkInstallations(db, 'orgA', [acme])).kind).toBe('linked')
  })

  test('an installation another organization has is linked to this one too', async () => {
    const db = await migratedD1()
    await linkInstallations(db, 'orgA', [acme])

    expect(await linkInstallations(db, 'orgB', [acme, other])).toEqual({
      kind: 'linked',
      installations: [acme, other],
    })

    expect(await orgsOfInstallation(db, 1)).toEqual(['orgA', 'orgB'])
    expect(await orgsOfInstallation(db, 2)).toEqual(['orgB'])
  })

  test('with nothing installed there is nothing to link', async () => {
    expect(await linkInstallations(await migratedD1(), 'orgA', [])).toEqual({ kind: 'none' })
  })
})

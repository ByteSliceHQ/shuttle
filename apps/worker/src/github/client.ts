import type { ShuttleEnv } from '../env'
import type { LinkedRepo } from '../workspace/scope'

interface CachedToken {
  readonly token: string
  readonly expiresAt: number
}

const installationTokens = new Map<number, CachedToken>()

export interface GithubAccount {
  readonly login: string
  readonly type: string
  readonly avatarUrl: string
}

export interface GithubInstallation {
  readonly id: number
  readonly account: GithubAccount
  readonly permissions: Readonly<Record<string, string>>
  readonly htmlUrl: string
}

/** GraphQL can answer 200 with errors; keep the error types and any partial data. */
export class GithubGraphqlError extends Error {
  constructor(
    message: string,
    readonly types: readonly string[],
    readonly data: unknown,
  ) {
    super(message)
    this.name = 'GithubGraphqlError'
  }
}

function requireGithubConfig(env: ShuttleEnv): {
  appId: string
  privateKey: string
} {
  const appId = env.GITHUB_APP_ID
  const privateKey = env.GITHUB_APP_PRIVATE_KEY

  if (!appId || !privateKey) {
    throw new Error('GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required')
  }

  return { appId, privateKey }
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const normalized = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '')

  const binary = atob(normalized)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes.buffer
}

export function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''

  for (const byte of view) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

/** Build a short-lived GitHub App JWT (RS256) with WebCrypto. */
export async function createAppJwt(env: ShuttleEnv, now = Date.now()): Promise<string> {
  const { appId, privateKey } = requireGithubConfig(env)
  const header = { alg: 'RS256', typ: 'JWT' }
  const issuedAt = Math.floor(now / 1000) - 60

  const payload = {
    iat: issuedAt,
    exp: issuedAt + 9 * 60,
    iss: appId,
  }

  const encodedHeader = base64Url(new TextEncoder().encode(JSON.stringify(header)))
  const encodedPayload = base64Url(new TextEncoder().encode(JSON.stringify(payload)))
  const signingInput = `${encodedHeader}.${encodedPayload}`

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(privateKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput),
  )

  return `${signingInput}.${base64Url(signature)}`
}

export async function githubFetch(
  env: ShuttleEnv,
  path: string,
  init: RequestInit & { token?: string; apiVersion?: string } = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/vnd.github+json')
  headers.set('X-GitHub-Api-Version', init.apiVersion ?? '2022-11-28')
  headers.set('User-Agent', 'shuttle-looms')

  if (init.token) {
    headers.set('Authorization', `Bearer ${init.token}`)
  } else {
    headers.set('Authorization', `Bearer ${await createAppJwt(env)}`)
  }

  const { token: _token, apiVersion: _apiVersion, ...rest } = init
  return fetch(`https://api.github.com${path}`, { ...rest, headers })
}

/** Optional user/PAT from env — covers PR sync/create when the App lacks scopes. */
export function githubUserToken(env: ShuttleEnv): string | null {
  const token = env.GITHUB_TOKEN?.trim()
  return token ? token : null
}

function isGithubForbidden(cause: unknown): boolean {
  if (cause instanceof GithubGraphqlError) {
    return cause.types.includes('FORBIDDEN')
  }

  if (cause instanceof Error) {
    return /(?:^|\D)403(?:\D|$)|resource not accessible by integration/i.test(cause.message)
  }

  return false
}

export async function githubGraphqlWithToken<T>(
  query: string,
  variables: Record<string, unknown>,
  token: string,
): Promise<T> {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'shuttle-looms',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ query, variables }),
  })

  if (!response.ok) {
    throw new Error(`GitHub GraphQL failed: ${response.status}`)
  }

  const body = (await response.json()) as {
    data?: T
    errors?: { message: string; type?: string }[]
  }

  if (body.errors?.length) {
    throw new GithubGraphqlError(
      `GitHub GraphQL errors: ${body.errors.map((error) => error.message).join('; ')}`,
      body.errors.flatMap((error) => (error.type ? [error.type] : [])),
      body.data ?? null,
    )
  }

  if (!body.data) {
    throw new Error('GitHub GraphQL response missing data')
  }

  return body.data
}

export async function githubGraphql<T>(
  env: ShuttleEnv,
  query: string,
  variables: Record<string, unknown>,
  installationId: number,
): Promise<T> {
  try {
    return await githubGraphqlWithToken(
      query,
      variables,
      await getInstallationToken(env, installationId),
    )
  } catch (cause) {
    const user = githubUserToken(env)

    if (!user || !isGithubForbidden(cause)) {
      throw cause
    }

    return await githubGraphqlWithToken(query, variables, user)
  }
}

export async function getInstallationToken(
  env: ShuttleEnv,
  installationId: number,
): Promise<string> {
  const cached = installationTokens.get(installationId)

  if (cached && cached.expiresAt > Date.now() + 5 * 60_000) {
    return cached.token
  }

  const response = await githubFetch(env, `/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
  })

  if (!response.ok) {
    throw new Error(`Failed to mint installation token: ${response.status}`)
  }

  const body = (await response.json()) as { token?: string; expires_at?: string }

  if (!body.token || !body.expires_at) {
    throw new Error('Installation token response missing token or expires_at')
  }

  installationTokens.set(installationId, {
    token: body.token,
    expiresAt: Date.parse(body.expires_at),
  })

  return body.token
}

export async function getInstallation(
  env: ShuttleEnv,
  installationId: number,
): Promise<GithubInstallation | null> {
  const response = await githubFetch(env, `/app/installations/${installationId}`)

  if (response.status === 404) {
    return null
  }

  if (!response.ok) {
    throw new Error(`Failed to load installation: ${response.status}`)
  }

  const body = (await response.json()) as {
    id: number
    account?: { login?: string; type?: string; avatar_url?: string }
    permissions?: Record<string, string>
    html_url?: string
  }

  return {
    id: body.id,
    account: {
      login: body.account?.login ?? 'unknown',
      type: body.account?.type ?? 'Organization',
      avatarUrl: body.account?.avatar_url ?? '',
    },
    permissions: body.permissions ?? {},
    htmlUrl: body.html_url ?? '',
  }
}

export async function listInstallationRepos(
  env: ShuttleEnv,
  installationId: number,
): Promise<LinkedRepo[]> {
  const token = await getInstallationToken(env, installationId)
  const repos: LinkedRepo[] = []
  let page = 1

  while (page <= 10) {
    const response = await githubFetch(
      env,
      `/installation/repositories?per_page=100&page=${page}`,
      { token },
    )

    if (!response.ok) {
      throw new Error(`Failed to list installation repositories: ${response.status}`)
    }

    const body = (await response.json()) as {
      repositories?: {
        name: string
        full_name: string
        private: boolean
        default_branch?: string
        owner?: { login?: string }
      }[]
    }

    const batch = body.repositories ?? []

    for (const repo of batch) {
      repos.push({
        installationId,
        owner: repo.owner?.login ?? repo.full_name.split('/')[0] ?? '',
        name: repo.name,
        fullName: repo.full_name,
        defaultBranch: repo.default_branch ?? 'main',
        private: repo.private,
      })
    }

    if (batch.length < 100) {
      break
    }

    page += 1
  }

  return repos
}

export async function fetchRepoTarball(
  env: ShuttleEnv,
  repo: LinkedRepo,
  ref?: string,
): Promise<ArrayBuffer> {
  const token = await getInstallationToken(env, repo.installationId)
  const target = ref ?? repo.defaultBranch

  const response = await githubFetch(
    env,
    `/repos/${repo.owner}/${repo.name}/tarball/${encodeURIComponent(target)}`,
    { token, redirect: 'follow' },
  )

  if (!response.ok) {
    throw new Error(`Failed to download tarball for ${repo.fullName}: ${response.status}`)
  }

  return response.arrayBuffer()
}

/** Resolve the commit SHA for a branch or tag. */
export async function resolveRefSha(
  env: ShuttleEnv,
  repo: LinkedRepo,
  ref: string,
): Promise<string> {
  const token = await getInstallationToken(env, repo.installationId)
  const encoded = encodeURIComponent(ref)

  const response = await githubFetch(env, `/repos/${repo.owner}/${repo.name}/commits/${encoded}`, {
    token,
  })

  if (!response.ok) {
    throw new Error(`Failed to resolve ref ${ref} for ${repo.fullName}: ${response.status}`)
  }

  const body = (await response.json()) as { sha?: string }

  if (!body.sha) {
    throw new Error(`Ref ${ref} for ${repo.fullName} missing sha`)
  }

  return body.sha
}

export async function signState(env: ShuttleEnv, payload: string): Promise<string> {
  const secret = env.GITHUB_STATE_SECRET ?? env.GITHUB_APP_PRIVATE_KEY

  if (!secret) {
    throw new Error('GITHUB_STATE_SECRET is required')
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return `${payload}.${base64Url(signature)}`
}

export async function verifyState(env: ShuttleEnv, state: string): Promise<string | null> {
  const separator = state.lastIndexOf('.')

  if (separator <= 0) {
    return null
  }

  const payload = state.slice(0, separator)
  const expected = await signState(env, payload)
  return expected === state ? payload : null
}

/** Clear cached tokens (tests). */
export function clearInstallationTokenCache(): void {
  installationTokens.clear()
}

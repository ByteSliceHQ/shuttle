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

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
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

async function githubFetch(
  env: ShuttleEnv,
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/vnd.github+json')
  headers.set('X-GitHub-Api-Version', '2022-11-28')
  headers.set('User-Agent', 'shuttle-looms')

  if (init.token) {
    headers.set('Authorization', `Bearer ${init.token}`)
  } else {
    headers.set('Authorization', `Bearer ${await createAppJwt(env)}`)
  }

  const { token: _token, ...rest } = init
  return fetch(`https://api.github.com${path}`, { ...rest, headers })
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
  }

  return {
    id: body.id,
    account: {
      login: body.account?.login ?? 'unknown',
      type: body.account?.type ?? 'Organization',
      avatarUrl: body.account?.avatar_url ?? '',
    },
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

export async function fetchRepoTarball(env: ShuttleEnv, repo: LinkedRepo): Promise<ArrayBuffer> {
  const token = await getInstallationToken(env, repo.installationId)

  const response = await githubFetch(
    env,
    `/repos/${repo.owner}/${repo.name}/tarball/${encodeURIComponent(repo.defaultBranch)}`,
    { token, redirect: 'follow' },
  )

  if (!response.ok) {
    throw new Error(`Failed to download tarball for ${repo.fullName}: ${response.status}`)
  }

  return response.arrayBuffer()
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

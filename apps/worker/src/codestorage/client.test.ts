import { describe, expect, test } from 'bun:test'

import {
  codeStorageClient,
  codeStorageConfigured,
  codeStorageGitUrl,
  codeStorageRepoName,
  gitBasicAuth,
  readToken,
  scratchRepoName,
  sessionRefPolicies,
  sessionToken,
  TOKEN_TTL_SECONDS,
} from './client'

/** A signing key like the one Code Storage's Keys page hands out: ECDSA P-256, PKCS8 PEM. */
async function testKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])

  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  const body = der.toString('base64').replaceAll(/(.{64})/g, '$1\n')

  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`
}

function claims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))
}

const ORG = 'AQz2U7YhUr93mdvwWRF0xxKRNthpC0Gb'
const RUN = `o-${ORG}-session_1f0e`

describe('code storage names', () => {
  test('each Shuttle organization has its own mirror of a GitHub repository', () => {
    expect(codeStorageRepoName(ORG, 'ByteSliceHQ/Shuttle')).toBe(`org-${ORG}/byteslicehq--shuttle`)

    expect(codeStorageRepoName('otherOrg', 'ByteSliceHQ/Shuttle')).not.toBe(
      codeStorageRepoName(ORG, 'ByteSliceHQ/Shuttle'),
    )
  })

  test('a session with no linked repository has a scratch repository of its own', () => {
    expect(scratchRepoName(ORG, `o-${ORG}-session_1F0e`)).toBe(`org-${ORG}/scratch--session_1f0e`)

    expect(scratchRepoName(ORG, `o-${ORG}-session_a`)).not.toBe(
      scratchRepoName(ORG, `o-${ORG}-session_b`),
    )
  })

  test('git urls carry no credential', () => {
    const env = { PIERRE_ORG: 'acme', PIERRE_PRIVATE_KEY: 'x' }

    expect(codeStorageGitUrl(env, 'org-1/a--b')).toBe('https://acme.code.storage/org-1/a--b.git')

    expect(codeStorageGitUrl(env, 'org-1/a--b', 'ephemeral')).toBe(
      'https://acme.code.storage/org-1/a--b+ephemeral.git',
    )

    expect(atob(gitBasicAuth('tok'))).toBe('t:tok')
  })

  test('is configured only with both an organization and a key', () => {
    expect(codeStorageConfigured({ PIERRE_ORG: 'acme', PIERRE_PRIVATE_KEY: 'x' })).toBe(true)
    expect(codeStorageConfigured({ PIERRE_ORG: 'acme' })).toBe(false)
    expect(codeStorageConfigured({ PIERRE_ORG: ' ', PIERRE_PRIVATE_KEY: 'x' })).toBe(false)
    expect(() => codeStorageClient({})).toThrow('Code Storage is unavailable')
  })
})

describe('code storage tokens', () => {
  test('a session may push only its own ephemeral branches', () => {
    expect(sessionRefPolicies(RUN)).toEqual([
      { pattern: `refs/namespaces/ephemeral/refs/heads/sessions/${RUN}/*` },
      { pattern: '*', ops: ['no-push'] },
    ])
  })

  test('a clone token reads one repository and nothing else', async () => {
    const client = codeStorageClient({ PIERRE_ORG: 'acme', PIERRE_PRIVATE_KEY: await testKey() })
    const token = claims(await readToken(client, 'org-1/a--b', 'sandbox-clone'))

    expect(token).toMatchObject({ iss: 'acme', repo: 'org-1/a--b', scopes: ['git:read'] })
    expect(Number(token.exp) - Number(token.iat)).toBeLessThanOrEqual(TOKEN_TTL_SECONDS)
  })

  test('a session token is confined to its repository and its branches', async () => {
    // A key pasted into a one-line setting carries its line breaks as \n.
    const oneLine = (await testKey()).trim().replaceAll('\n', String.raw`\n`)
    const client = codeStorageClient({ PIERRE_ORG: 'acme', PIERRE_PRIVATE_KEY: oneLine })
    const token = claims(await sessionToken(client, 'org-1/a--b', RUN))

    expect(token).toMatchObject({
      iss: 'acme',
      repo: 'org-1/a--b',
      scopes: ['git:read', 'git:write'],
      refs: [
        [`refs/namespaces/ephemeral/refs/heads/sessions/${RUN}/*`, []],
        ['*', ['no-push']],
      ],
    })

    expect(Number(token.exp) - Number(token.iat)).toBeLessThanOrEqual(TOKEN_TTL_SECONDS)
  })
})

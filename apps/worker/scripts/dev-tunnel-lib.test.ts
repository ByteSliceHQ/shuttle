import { describe, expect, test } from 'bun:test'

import { verifyWebhookSignature } from '../src/github/webhooks'
import {
  fillEmptyGithubToken,
  ensureCredentialsKeyLine,
  fillEmptySecrets,
  parseTunnelUrl,
  parseTunnelUrlFromMetrics,
  signWebhookBody,
} from './dev-tunnel-lib'

describe('parseTunnelUrl', () => {
  test('extracts the trycloudflare URL from cloudflared log lines', () => {
    expect(
      parseTunnelUrl(
        '2026-03-26T12:00:00Z INF |  https://foo-bar-baz.trycloudflare.com                        |',
      ),
    ).toBe('https://foo-bar-baz.trycloudflare.com')

    expect(
      parseTunnelUrl(
        'INF Thank you for trying Cloudflare Tunnel. Your quick Tunnel has been created! Visit it at (it may take some time to be reachable): https://alpha-beta.trycloudflare.com',
      ),
    ).toBe('https://alpha-beta.trycloudflare.com')
  })

  test('returns null when no tunnel URL is present', () => {
    expect(parseTunnelUrl('INF Starting tunnel')).toBeNull()
    expect(parseTunnelUrl('https://example.com')).toBeNull()
  })
})

describe('parseTunnelUrlFromMetrics', () => {
  test('extracts the hostname counter label', () => {
    const metrics = [
      'cloudflared_tunnel_ha_connections 1',
      'cloudflared_tunnel_user_hostnames_counts{userHostname="https://foo-bar.trycloudflare.com"} 1',
      'cloudflared_tunnel_total_requests 2',
    ].join('\n')

    expect(parseTunnelUrlFromMetrics(metrics)).toBe('https://foo-bar.trycloudflare.com')
  })

  test('returns null when the counter is missing', () => {
    expect(parseTunnelUrlFromMetrics('cloudflared_tunnel_ha_connections 1')).toBeNull()
  })
})

describe('ensureCredentialsKeyLine', () => {
  test('adds the line once to a file that lacks it', () => {
    const added = ensureCredentialsKeyLine('OPENROUTER_API_KEY=abc\n')

    expect(added).toContain('OPENROUTER_API_KEY=abc\n')
    expect(added.endsWith('SHUTTLE_CREDENTIALS_KEY=\n')).toBe(true)
    expect(ensureCredentialsKeyLine(added)).toBe(added)
  })

  test('leaves a set key alone', () => {
    const text = 'SHUTTLE_CREDENTIALS_KEY=already\n'

    expect(ensureCredentialsKeyLine(text)).toBe(text)
  })
})

describe('fillEmptySecrets', () => {
  test('fills only empty secret lines and leaves the rest alone', () => {
    const input = [
      'OPENROUTER_API_KEY=keep-me',
      'GITHUB_WEBHOOK_SECRET=',
      'GITHUB_STATE_SECRET=already-set',
      '# comment',
      'GITHUB_APP_ID=123',
      '',
    ].join('\n')

    let n = 0
    const result = fillEmptySecrets(input, () => `secret-${++n}`)

    expect(result.filled).toEqual(['GITHUB_WEBHOOK_SECRET'])
    expect(result.text).toContain('GITHUB_WEBHOOK_SECRET=secret-1')
    expect(result.text).toContain('GITHUB_STATE_SECRET=already-set')
    expect(result.text).toContain('OPENROUTER_API_KEY=keep-me')
    expect(result.text).toContain('GITHUB_APP_ID=123')
  })

  test('fills both secrets when empty', () => {
    const input = 'GITHUB_WEBHOOK_SECRET=\nGITHUB_STATE_SECRET=\n'
    let n = 0
    const result = fillEmptySecrets(input, () => `s${++n}`)

    expect(result.filled).toEqual(['GITHUB_WEBHOOK_SECRET', 'GITHUB_STATE_SECRET'])
    expect(result.text).toBe('GITHUB_WEBHOOK_SECRET=s1\nGITHUB_STATE_SECRET=s2\n')
  })

  test('is a no-op when secrets are already set', () => {
    const input = 'GITHUB_WEBHOOK_SECRET=a\nGITHUB_STATE_SECRET=b\n'
    const result = fillEmptySecrets(input, () => 'nope')

    expect(result.filled).toEqual([])
    expect(result.text).toBe(input)
  })
})

describe('fillEmptyGithubToken', () => {
  test('fills an empty GITHUB_TOKEN line', () => {
    const result = fillEmptyGithubToken('GITHUB_TOKEN=\nLOOMS_MODEL=x\n', 'gho_test')

    expect(result.filled).toBe(true)
    expect(result.text).toContain('GITHUB_TOKEN=gho_test')
  })

  test('appends the key when missing', () => {
    const result = fillEmptyGithubToken('LOOMS_MODEL=x\n', 'gho_test')

    expect(result.filled).toBe(true)
    expect(result.text).toBe('LOOMS_MODEL=x\nGITHUB_TOKEN=gho_test\n')
  })

  test('leaves a set token alone', () => {
    const input = 'GITHUB_TOKEN=already\n'
    const result = fillEmptyGithubToken(input, 'gho_new')

    expect(result.filled).toBe(false)
    expect(result.text).toBe(input)
  })
})

describe('signWebhookBody', () => {
  test('round-trips through verifyWebhookSignature', async () => {
    const secret = 'whsec_test_roundtrip'
    const body = JSON.stringify({ zen: 'Design for failure.', hook_id: 1 })
    const signature = await signWebhookBody(secret, body)

    const ok = await verifyWebhookSignature(
      { GITHUB_WEBHOOK_SECRET: secret } as never,
      body,
      signature,
    )

    expect(ok).toBe(true)
    expect(signature.startsWith('sha256=')).toBe(true)
  })
})

/** Pure helpers shared by `dev-setup` and `dev-tunnel`. */

const SECRET_KEYS = [
  'GITHUB_WEBHOOK_SECRET',
  'GITHUB_STATE_SECRET',
  'SHUTTLE_CREDENTIALS_KEY',
] as const

export type SecretKey = (typeof SECRET_KEYS)[number]

export interface FillSecretsResult {
  readonly text: string
  readonly filled: readonly SecretKey[]
}

/** Pull the trycloudflare URL out of a cloudflared log line. */
export function parseTunnelUrl(line: string): string | null {
  const match = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)
  return match?.[0] ?? null
}

/**
 * Pull the quick-tunnel hostname from cloudflared's Prometheus metrics.
 * Used as a fallback when stderr is swallowed by a wrapper process.
 */
export function parseTunnelUrlFromMetrics(metricsText: string): string | null {
  const match = metricsText.match(
    /cloudflared_tunnel_user_hostnames_counts\{userHostname="(https:\/\/[a-z0-9-]+\.trycloudflare\.com)"\}/i,
  )

  return match?.[1] ?? null
}

/**
 * Adds an empty `SHUTTLE_CREDENTIALS_KEY=` line to a `.dev.vars` file that predates it, so
 * `fillEmptySecrets` can fill it. Without the key, coding agent sign-ins cannot be stored.
 */
export function ensureCredentialsKeyLine(text: string): string {
  if (/^SHUTTLE_CREDENTIALS_KEY=/m.test(text)) {
    return text
  }

  const comment = '# Encrypts stored coding agent subscription credentials.'

  return `${text.replace(/\n*$/, '')}\n\n${comment}\nSHUTTLE_CREDENTIALS_KEY=\n`
}

/** Fill empty secret assignments in a `.dev.vars` file; leave set values alone. */
export function fillEmptySecrets(
  text: string,
  generate: () => string = randomHexSecret,
): FillSecretsResult {
  const filled: SecretKey[] = []

  const next = text
    .split('\n')
    .map((line) => {
      for (const key of SECRET_KEYS) {
        const match = line.match(new RegExp(`^(${key})=(.*)$`))

        if (!match) {
          continue
        }

        const value = match[2] ?? ''

        if (value.trim() !== '') {
          return line
        }

        const secret = generate()
        filled.push(key)
        return `${key}=${secret}`
      }

      return line
    })
    .join('\n')

  return { text: next, filled }
}

/**
 * Set `GITHUB_TOKEN` when the key is missing or empty and a token is available
 * (typically from `gh auth token`). Never overwrites a non-empty value.
 */
export function fillEmptyGithubToken(
  text: string,
  token: string | null,
): { readonly text: string; readonly filled: boolean } {
  if (!token?.trim()) {
    return { text, filled: false }
  }

  const lines = text.split('\n')
  let found = false
  let filled = false

  const next = lines.map((line) => {
    const match = line.match(/^(GITHUB_TOKEN)=(.*)$/)

    if (!match) {
      return line
    }

    found = true
    const value = match[2] ?? ''

    if (value.trim() !== '') {
      return line
    }

    filled = true
    return `GITHUB_TOKEN=${token.trim()}`
  })

  if (!found) {
    const suffix = text.endsWith('\n') || text.length === 0 ? '' : '\n'
    return { text: `${text}${suffix}GITHUB_TOKEN=${token.trim()}\n`, filled: true }
  }

  return { text: next.join('\n'), filled }
}

export function randomHexSecret(bytes = 32): string {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  return [...buffer].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** HMAC-SHA256 GitHub webhook signature (`sha256=<hex>`). */
export async function signWebhookBody(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  return `sha256=${hex(signature)}`
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

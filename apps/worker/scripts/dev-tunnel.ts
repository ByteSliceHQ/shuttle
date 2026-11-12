#!/usr/bin/env bun
import { existsSync } from 'node:fs'

/**
 * Cloudflare quick tunnel for local GitHub webhook delivery.
 *
 * Skips cleanly when SHUTTLE_TUNNEL=off or GitHub App credentials are missing.
 * Otherwise: spawn cloudflared → PATCH App webhook config → signed ping self-test.
 */
import { spawn, which, type Subprocess } from 'bun'

import type { ShuttleEnv } from '../src/env'
import { createAppJwt } from '../src/github/client'
import { parseTunnelUrl, parseTunnelUrlFromMetrics, signWebhookBody } from './dev-tunnel-lib'

const WORKER_ORIGIN = 'http://127.0.0.1:8790'
const WEBHOOK_PATH = '/github/webhooks'

function env(name: string): string | undefined {
  const value = process.env[name]
  return value && value.trim() !== '' ? value : undefined
}

function skip(reason: string): never {
  console.log(`[tunnel] skip — ${reason}`)
  process.exit(0)
}

if (env('SHUTTLE_TUNNEL') === 'off') {
  skip('SHUTTLE_TUNNEL=off')
}

const appId = env('GITHUB_APP_ID')
const privateKey = env('GITHUB_APP_PRIVATE_KEY')
const webhookSecret = env('GITHUB_WEBHOOK_SECRET')

if (!appId || !privateKey) {
  skip('GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY not set')
}

if (!webhookSecret) {
  skip('GITHUB_WEBHOOK_SECRET is empty (run bun run dev so dev-setup can fill it)')
}

const githubEnv = {
  GITHUB_APP_ID: appId,
  GITHUB_APP_PRIVATE_KEY: privateKey,
  GITHUB_WEBHOOK_SECRET: webhookSecret,
} as ShuttleEnv

/**
 * Prefer a real cloudflared binary.
 * Turbo puts `node_modules/.bin` on PATH; the npm `cloudflared` shim is a Node
 * wrapper that does not reliably forward the real process's stderr, so we never
 * see the trycloudflare.com URL and never PATCH the GitHub App webhook.
 */
async function resolveCloudflared(): Promise<string> {
  const onPath = which('cloudflared')

  if (onPath && !onPath.includes('/node_modules/')) {
    return onPath
  }

  const { bin, install } = await import('cloudflared')

  if (!existsSync(bin)) {
    console.log('[tunnel] installing cloudflared binary…')
    await install(bin)
  }

  return bin
}

async function pollMetricsHostname(timeoutMs = 60_000): Promise<string> {
  const started = Date.now()
  let attempt = 0

  while (Date.now() - started < timeoutMs) {
    attempt += 1

    try {
      const response = await fetch('http://127.0.0.1:20241/metrics', {
        signal: AbortSignal.timeout(2_000),
      })

      if (response.ok) {
        const found = parseTunnelUrlFromMetrics(await response.text())

        if (found) {
          return found
        }
      }
    } catch {
      // metrics port not up yet
    }

    await Bun.sleep(Math.min(2_000, 250 * attempt))
  }

  throw new Error('timed out waiting for trycloudflare.com hostname in cloudflared metrics')
}

async function waitForUrl(url: string, label: string, timeoutMs = 90_000): Promise<void> {
  const started = Date.now()
  let attempt = 0

  while (Date.now() - started < timeoutMs) {
    attempt += 1

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000) })

      if (response.ok) {
        return
      }
    } catch {
      // not ready
    }

    const delay = Math.min(2_000, 250 * attempt)
    await Bun.sleep(delay)
  }

  throw new Error(`timed out waiting for ${label} (${url})`)
}

async function syncWebhookConfig(tunnelOrigin: string): Promise<void> {
  const jwt = await createAppJwt(githubEnv)
  const url = `${tunnelOrigin}${WEBHOOK_PATH}`

  const response = await fetch('https://api.github.com/app/hook/config', {
    method: 'PATCH',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      'User-Agent': 'shuttle-looms-dev-tunnel',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({
      url,
      content_type: 'json',
      secret: webhookSecret,
      insecure_ssl: '0',
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(
      `PATCH /app/hook/config failed (${response.status}): ${body.slice(0, 200)}. ` +
        'Enable webhooks ("Active") once in the GitHub App settings, then restart.',
    )
  }
}

async function selfTest(tunnelOrigin: string): Promise<void> {
  const body = JSON.stringify({
    zen: 'Design for failure.',
    hook_id: 0,
    hook: { type: 'App', id: 0, active: true, events: ['ping'] },
  })

  const signature = await signWebhookBody(webhookSecret!, body)

  const response = await fetch(`${tunnelOrigin}${WEBHOOK_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': 'ping',
      'X-GitHub-Delivery': crypto.randomUUID(),
      'X-Hub-Signature-256': signature,
      'User-Agent': 'shuttle-looms-dev-tunnel',
    },
    body,
  })

  if (response.status === 401) {
    throw new Error(
      'self-test got 401 — GITHUB_WEBHOOK_SECRET does not match what the worker loaded. ' +
        'Restart wrangler after secrets change.',
    )
  }

  if (!response.ok) {
    throw new Error(`self-test failed: ${response.status} ${await response.text()}`)
  }
}

interface TunnelHandle {
  readonly child: Subprocess
  readonly url: Promise<string>
}

function spawnTunnel(binary: string): TunnelHandle {
  const child = spawn({
    cmd: [binary, 'tunnel', '--no-autoupdate', '--url', WORKER_ORIGIN],
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  })

  const deferred: {
    settled: boolean
    resolve: ((url: string) => void) | null
    reject: ((error: Error) => void) | null
  } = { settled: false, resolve: null, reject: null }

  const url = new Promise<string>((resolve, reject) => {
    deferred.resolve = resolve
    deferred.reject = reject
  })

  const onChunk = (chunk: Uint8Array) => {
    const text = new TextDecoder().decode(chunk)
    process.stderr.write(text)

    if (deferred.settled) {
      return
    }

    for (const line of text.split('\n')) {
      const found = parseTunnelUrl(line)

      if (found) {
        deferred.settled = true
        deferred.resolve?.(found)
        return
      }
    }
  }

  void (async () => {
    if (child.stderr) {
      for await (const chunk of child.stderr) {
        onChunk(chunk)
      }
    }
  })()

  void (async () => {
    if (child.stdout) {
      for await (const chunk of child.stdout) {
        onChunk(chunk)
      }
    }
  })()

  void child.exited.then((code) => {
    if (!deferred.settled) {
      deferred.settled = true
      deferred.reject?.(new Error(`cloudflared exited before publishing a URL (code ${code})`))
    }
  })

  return { child, url }
}

let currentChild: Subprocess | null = null
let keepRunning = true

async function shutdown(signal: string) {
  if (!keepRunning) {
    return
  }

  keepRunning = false
  console.log(`[tunnel] shutting down (${signal})`)

  if (currentChild) {
    try {
      currentChild.kill()
    } catch {
      // already gone
    }
  }

  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

async function runOnce(binary: string): Promise<void> {
  console.log(`[tunnel] starting cloudflared → ${WORKER_ORIGIN}`)
  await waitForUrl(`${WORKER_ORIGIN}/health`, 'local worker')

  const { child, url: urlPromise } = spawnTunnel(binary)
  currentChild = child

  console.log('[tunnel] waiting for public trycloudflare.com URL…')

  const origin = await Promise.race([
    urlPromise,
    pollMetricsHostname(60_000),
    Bun.sleep(90_000).then(() => {
      throw new Error('timed out waiting for trycloudflare.com URL from cloudflared')
    }),
  ])

  console.log(`[tunnel] public origin ${origin}`)
  await waitForUrl(`${origin}/health`, 'tunnel')

  try {
    await syncWebhookConfig(origin)
    console.log(`[tunnel] GitHub App webhook → ${origin}${WEBHOOK_PATH}`)
  } catch (error) {
    console.warn(`[tunnel] webhook sync failed: ${error instanceof Error ? error.message : error}`)
  }

  try {
    await selfTest(origin)
    console.log(`[tunnel] webhooks live  ${origin}${WEBHOOK_PATH}  (self-test ok)`)
  } catch (error) {
    console.warn(`[tunnel] self-test failed: ${error instanceof Error ? error.message : error}`)
    console.log(`[tunnel] webhooks live  ${origin}${WEBHOOK_PATH}  (self-test failed)`)
  }

  const code = await child.exited
  currentChild = null

  if (keepRunning) {
    console.warn(`[tunnel] cloudflared exited with code ${code}; restarting…`)
  }
}

const binary = await resolveCloudflared()
let backoffMs = 1_000

for (;;) {
  if (!keepRunning) {
    break
  }

  try {
    await runOnce(binary)
    backoffMs = 1_000
  } catch (error) {
    console.warn(`[tunnel] ${error instanceof Error ? error.message : error}`)
  }

  if (!keepRunning) {
    break
  }

  await Bun.sleep(backoffMs)
  backoffMs = Math.min(backoffMs * 2, 15_000)
}

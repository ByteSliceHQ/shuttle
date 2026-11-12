import { describe, expect, test } from 'bun:test'

import type { ShuttleEnv } from '../env'
import { createAppJwt, signState, verifyState } from './app'

async function generatePkcs8Pem(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )

  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey)
  const bytes = new Uint8Array(pkcs8)
  let binary = ''

  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  const b64 = btoa(binary)
  const lines = b64.match(/.{1,64}/g) ?? []
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`
}

describe('github app jwt', () => {
  test('signs an RS256 app JWT', async () => {
    const privateKey = await generatePkcs8Pem()

    const env = {
      GITHUB_APP_ID: '12345',
      GITHUB_APP_PRIVATE_KEY: privateKey,
      LOOMS_RUN: {} as DurableObjectNamespace,
      SANDBOX: {} as DurableObjectNamespace,
      EVENT_FIREHOSE: {} as DurableObjectNamespace,
    } satisfies ShuttleEnv

    const jwt = await createAppJwt(env)
    const [header, payload, signature] = jwt.split('.')
    expect(header).toBeTruthy()
    expect(payload).toBeTruthy()
    expect(signature).toBeTruthy()

    const decoded = JSON.parse(atob(payload!.replace(/-/g, '+').replace(/_/g, '/'))) as {
      iss: string
    }

    expect(decoded.iss).toBe('12345')
  })

  test('signs and verifies oauth state', async () => {
    const env = {
      GITHUB_STATE_SECRET: 'test-secret',
      LOOMS_RUN: {} as DurableObjectNamespace,
      SANDBOX: {} as DurableObjectNamespace,
      EVENT_FIREHOSE: {} as DurableObjectNamespace,
    } satisfies ShuttleEnv

    const state = await signState(env, 'install:nonce:1')
    expect(await verifyState(env, state)).toBe('install:nonce:1')
    expect(await verifyState(env, state + 'tampered')).toBeNull()
  })
})

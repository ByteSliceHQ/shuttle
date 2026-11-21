import { describe, expect, test } from 'bun:test'

import { createORPCClient } from '@orpc/client'
import type { ContractRouterClient } from '@orpc/contract'
import { OpenAPILink } from '@orpc/openapi-client/fetch'

import { contract } from '@shuttle/api'
import type { Actor } from '@shuttle/engine/tenancy/access'
import { fakeBucket } from '@shuttle/engine/testing/fake-r2'

import type { ShuttleEnv } from '../env'
import { fakeEnv } from '../testing/fake-env'
import { handleApi } from './handler'

const actor: Actor = {
  userId: 'user1',
  orgId: 'org1',
  role: 'admin',
  name: 'Ada',
  email: 'ada@example.com',
}

const WEB_URL = 'https://app.shuttle.test'

/** Durable Objects that accept everything, except a session signal when `failSignal` is set. */
function fakeLooms(failSignal: boolean) {
  const signals: unknown[] = []

  const stub = {
    getRun: async () => ({ startIdentity: 'started' }),
    launch: async () => {},
    fetch: async () => new Response('{}', { status: 404 }),
    setAccess: async () => {},
    placeSandbox: async () => {},
    signal: async (events: unknown[]) => {
      if (failSignal) {
        throw new Error('workspace unavailable')
      }

      signals.push(...events)
      return {}
    },
  }

  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: the test namespace answers getByName, the only method the handler calls on a run namespace.
  return { namespace: { getByName: () => stub } as unknown as ShuttleEnv['LOOMS_RUN'], signals }
}

/** What a call rejects with; fails the test when the call succeeds. */
async function rejection(call: Promise<unknown>): Promise<Error> {
  try {
    await call
  } catch (error) {
    if (error instanceof Error) {
      return error
    }

    throw error
  }

  throw new Error('expected the call to be rejected')
}

/**
 * The app's own client, as the browser uses it, against the Worker's handler. A browser declares
 * a form's length and says the request is its own, so this does too unless told otherwise.
 */
function setup(options: { failSignal?: boolean; headers?: Record<string, string> } = {}) {
  const bucket = fakeBucket()
  const looms = fakeLooms(options.failSignal ?? false)
  const env = fakeEnv({ SHUTTLE_WEB_URL: WEB_URL, ASSETS: bucket, LOOMS_RUN: looms.namespace })

  const client: ContractRouterClient<typeof contract> = createORPCClient(
    new OpenAPILink(contract, {
      url: WEB_URL,
      fetch: async (input, init) => {
        const sent = new Request(input, init)
        // Copied first: Bun forgets a form's generated content type once its body is read.
        const headers = new Headers(sent.headers)
        const body = await sent.arrayBuffer()

        headers.set('content-length', String(body.byteLength))
        headers.set('origin', WEB_URL)
        headers.set('sec-fetch-site', 'same-origin')

        for (const [name, value] of Object.entries(options.headers ?? {})) {
          headers.set(name, value)
        }

        const request = new Request(sent.url, { method: sent.method, headers, body })
        const response = await handleApi({ env, actor, request })

        return response ?? new Response('Not found', { status: 404 })
      },
    }),
  )

  return { client, bucket, signals: looms.signals }
}

const png = (name = 'screen.png') => new File(['image'], name, { type: 'image/png' })

describe('initial session attachments', () => {
  test('stores files with a type from their name and passes them to the session', async () => {
    const { client, bucket, signals } = setup()

    const { runId } = await client.workspace.createSession({
      folderId: 'folder_1',
      goal: 'Fix the screenshot',
      files: [new File(['# notes'], 'notes.md'), png()],
    })

    expect(runId).toStartWith('o-org1-session_')
    expect(bucket.keys()).toHaveLength(2)

    const sent = JSON.stringify(signals)
    expect(sent).toContain('"mediaType":"text/markdown"')
    expect(sent).toContain('"mediaType":"image/png"')
  })

  test('a single file arrives as a list', async () => {
    const { client, bucket } = setup()

    await client.workspace.createSession({ folderId: 'f', goal: 'Look', files: [png()] })
    expect(bucket.keys()).toHaveLength(1)
  })

  test('removes stored files when the session cannot be started', async () => {
    const { client, bucket } = setup({ failSignal: true })

    await rejection(client.workspace.createSession({ folderId: 'f', goal: 'Look', files: [png()] }))

    expect(bucket.keys()).toEqual([])
  })

  test('rejects empty files and too many files', async () => {
    const { client, bucket } = setup()

    expect(
      await rejection(
        client.workspace.createSession({ folderId: 'f', goal: 'Look', files: [new File([], 'e')] }),
      ),
    ).toMatchObject({ status: 400 })

    expect(
      await rejection(
        client.workspace.createSession({
          folderId: 'f',
          goal: 'Look',
          files: Array.from({ length: 11 }, (_, index) => png(`${index}.png`)),
        }),
      ),
    ).toMatchObject({ status: 400 })

    expect(bucket.keys()).toEqual([])
  })

  test('refuses form posts from other sites, which skip the CORS preflight', async () => {
    const foreign: Record<string, string>[] = [
      { origin: 'https://preview.shuttle.test' },
      { 'sec-fetch-site': 'same-site' },
      { 'sec-fetch-site': 'cross-site' },
    ]

    for (const headers of foreign) {
      const { client, bucket } = setup({ headers })

      expect(
        await rejection(
          client.workspace.createSession({ folderId: 'f', goal: 'Look', files: [png()] }),
        ),
      ).toMatchObject({ status: 403 })

      expect(bucket.keys()).toEqual([])
    }
  })

  test('refuses a declared body over the limit before reading it', async () => {
    const { client } = setup({ headers: { 'content-length': String(50 * 1024 * 1024 + 1) } })

    expect(
      await rejection(
        client.workspace.createSession({ folderId: 'f', goal: 'Look', files: [png()] }),
      ),
    ).toMatchObject({ status: 413 })
  })

  test('a session without files is still plain JSON, with no origin needed', async () => {
    const { client, signals } = setup({ headers: { origin: 'https://elsewhere.test' } })

    await client.workspace.createSession({ folderId: 'f', goal: 'Look' })
    expect(JSON.stringify(signals)).not.toContain('attachments')
  })
})

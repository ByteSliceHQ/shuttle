import { describe, expect, test } from 'bun:test'

import type { ShuttleEnv } from '../env'
import type { Actor } from '../tenancy/access'
import { fakeEnv } from '../testing/fake-env'
import { fakeBucket } from '../testing/fake-r2'
import { handleWorkspaceRoutes } from './workspace'

const actor = { userId: 'user1', orgId: 'org1', name: 'Ada', email: 'ada@example.com' } as Actor

const WEB_URL = 'https://app.shuttle.test'

function submit(form: FormData, storage = true, headers: Record<string, string> = {}) {
  return handleWorkspaceRoutes(
    new Request(`${WEB_URL}/workspace/sessions`, { method: 'POST', body: form, headers }),
    fakeEnv({ SHUTTLE_WEB_URL: WEB_URL, ...(storage ? { ASSETS: fakeBucket() } : {}) }),
    actor,
  )
}

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

  return { namespace: { getByName: () => stub } as unknown as ShuttleEnv['LOOMS_RUN'], signals }
}

async function start(form: FormData, failSignal = false) {
  const bucket = fakeBucket()
  const looms = fakeLooms(failSignal)

  const response = handleWorkspaceRoutes(
    new Request(`${WEB_URL}/workspace/sessions`, {
      method: 'POST',
      body: form,
      headers: { origin: WEB_URL, 'sec-fetch-site': 'same-origin' },
    }),
    fakeEnv({ SHUTTLE_WEB_URL: WEB_URL, ASSETS: bucket, LOOMS_RUN: looms.namespace }),
    actor,
  )

  return {
    response: await response.catch((cause: unknown) => cause),
    bucket,
    signals: looms.signals,
  }
}

function sessionForm() {
  const form = new FormData()
  form.set('folderId', 'folder_1')
  form.set('goal', 'Fix the screenshot')
  return form
}

describe('initial session attachments', () => {
  test('rejects files when storage is unavailable before starting a session', async () => {
    const form = sessionForm()
    form.append('files', new File(['image'], 'screen.png', { type: 'image/png' }))
    expect((await submit(form, false))?.status).toBe(503)
  })

  test('rejects empty files, non-file entries, and too many files', async () => {
    for (const invalid of [new File([], 'empty.png'), 'not a file']) {
      const form = sessionForm()
      form.append('files', invalid)
      expect((await submit(form))?.status).toBe(400)
    }

    const form = sessionForm()

    for (let index = 0; index < 11; index++) {
      form.append('files', new File(['image'], `screen-${index}.png`))
    }

    expect((await submit(form))?.status).toBe(400)
  })

  test('keeps the existing goal and device validation for multipart requests', async () => {
    const form = sessionForm()
    form.set('goal', '  ')
    expect((await submit(form))?.status).toBe(400)
    form.set('goal', 'Fix this')
    form.set('deviceId', '../invalid')
    expect((await submit(form))?.status).toBe(400)
  })

  test('refuses form posts from other sites, which skip the CORS preflight', async () => {
    const foreign: Record<string, string>[] = [
      { origin: 'https://preview.shuttle.test' },
      { 'sec-fetch-site': 'same-site' },
      { 'sec-fetch-site': 'cross-site', origin: WEB_URL },
    ]

    for (const headers of foreign) {
      expect((await submit(sessionForm(), true, headers))?.status).toBe(403)
    }
  })

  test('refuses a declared body over the limit before reading it', async () => {
    const response = await submit(sessionForm(), true, {
      origin: WEB_URL,
      'content-length': String(50 * 1024 * 1024 + 1),
    })

    expect(response?.status).toBe(413)
  })

  test('stores attachments with a type from their name and passes them to the session', async () => {
    const form = sessionForm()
    form.append('files', new File(['# notes'], 'notes.md'))
    form.append('files', new File(['image'], 'screen.png', { type: 'image/png' }))

    const { response, bucket, signals } = await start(form)

    expect((response as Response).status).toBe(200)
    expect(bucket.keys()).toHaveLength(2)

    expect(JSON.stringify(signals)).toContain('"mediaType":"text/markdown"')
    expect(JSON.stringify(signals)).toContain('"mediaType":"image/png"')
  })

  test('removes stored attachments when the session cannot be started', async () => {
    const form = sessionForm()
    form.append('files', new File(['image'], 'screen.png', { type: 'image/png' }))

    const { response, bucket } = await start(form, true)

    expect((response as Error).message).toBe('workspace unavailable')
    expect(bucket.keys()).toEqual([])
  })
})

import { describe, expect, test } from 'bun:test'

import type { Actor } from '../tenancy/access'
import { fakeEnv } from '../testing/fake-env'
import { fakeBucket } from '../testing/fake-r2'
import { handleWorkspaceRoutes } from './workspace'

const actor = { userId: 'user_1', orgId: 'org_1', name: 'Ada', email: 'ada@example.com' } as Actor

function submit(form: FormData, storage = true) {
  return handleWorkspaceRoutes(
    new Request('https://shuttle.test/workspace/sessions', { method: 'POST', body: form }),
    fakeEnv(storage ? { ASSETS: fakeBucket() } : {}),
    actor,
  )
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
})

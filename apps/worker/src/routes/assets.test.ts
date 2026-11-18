import { describe, expect, test } from 'bun:test'

import { z } from 'zod'

import { MAX_ASSET_BYTES, type AssetRef } from '../assets/store'
import type { Actor } from '../tenancy/access'
import { fakeEnv } from '../testing/fake-env'
import { fakeBucket } from '../testing/fake-r2'
import { handleAssetRoutes } from './assets'

const actor: Actor = {
  userId: 'user_1',
  orgId: 'org_1',
  role: 'member',
  name: 'Ada',
  email: 'ada@example.com',
}

const UploadedSchema = z.object({
  asset: z.object({ id: z.string(), name: z.string(), mediaType: z.string(), size: z.number() }),
})

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4])

function upload(
  env: ReturnType<typeof fakeEnv>,
  runId: string,
  name: string,
  body: BodyInit,
  type = 'image/png',
) {
  return handleAssetRoutes(
    new Request(`https://shuttle.test/sessions/${runId}/assets?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'content-type': type },
      body,
    }),
    env,
    actor,
  )
}

async function uploaded(response: Response | null): Promise<AssetRef> {
  if (response?.status !== 201) {
    throw new Error(`upload answered ${response?.status}`)
  }

  return UploadedSchema.parse(await response.json()).asset
}

describe('session assets', () => {
  test('stores an upload under its session and serves it back', async () => {
    const env = fakeEnv({ ASSETS: fakeBucket() })
    const asset = await uploaded(await upload(env, 'run_a', 'Screen Shot.png', PNG))

    expect(asset).toMatchObject({ name: 'Screen Shot.png', mediaType: 'image/png', size: 12 })

    const served = await handleAssetRoutes(
      new Request(`https://shuttle.test/sessions/run_a/assets/${asset.id}`),
      env,
      actor,
    )

    expect(served?.status).toBe(200)
    expect(served?.headers.get('content-type')).toBe('image/png')
    expect(served?.headers.get('content-disposition')).toStartWith('inline')
    expect(served?.headers.get('content-security-policy')).toContain('sandbox')
    expect(new Uint8Array(await served!.arrayBuffer())).toEqual(PNG)
  })

  test("one session cannot read another session's file", async () => {
    const env = fakeEnv({ ASSETS: fakeBucket() })
    const asset = await uploaded(await upload(env, 'run_a', 'a.png', PNG))

    const other = await handleAssetRoutes(
      new Request(`https://shuttle.test/sessions/run_b/assets/${asset.id}`),
      env,
      actor,
    )

    expect(other?.status).toBe(404)
  })

  test('answers a range request with that part of the file', async () => {
    const env = fakeEnv({ ASSETS: fakeBucket() })
    const asset = await uploaded(await upload(env, 'run_a', 'clip.mp4', PNG, 'video/mp4'))

    const part = await handleAssetRoutes(
      new Request(`https://shuttle.test/sessions/run_a/assets/${asset.id}`, {
        headers: { range: 'bytes=4-7' },
      }),
      env,
      actor,
    )

    expect(part?.status).toBe(206)
    expect(part?.headers.get('content-range')).toBe('bytes 4-7/12')
    expect(new Uint8Array(await part!.arrayBuffer())).toEqual(PNG.slice(4, 8))
  })

  test('hands a page over as a download and never as the type it claims to be', async () => {
    const env = fakeEnv({ ASSETS: fakeBucket() })

    const asset = await uploaded(
      await upload(env, 'run_a', 'page.html', '<script>1</script>', 'text/html'),
    )

    const served = await handleAssetRoutes(
      new Request(`https://shuttle.test/sessions/run_a/assets/${asset.id}`),
      env,
      actor,
    )

    expect(served?.headers.get('content-disposition')).toStartWith('attachment')
    expect(served?.headers.get('x-content-type-options')).toBe('nosniff')
  })

  test('takes the type from the file name when the browser sends none', async () => {
    const env = fakeEnv({ ASSETS: fakeBucket() })

    const asset = await uploaded(
      await upload(env, 'run_a', 'memo.mp3', PNG, 'application/octet-stream'),
    )

    expect(asset.mediaType).toBe('audio/mpeg')
  })

  test('refuses an empty file, an oversized one, and any upload without storage', async () => {
    const env = fakeEnv({ ASSETS: fakeBucket() })

    expect((await upload(env, 'run_a', 'empty.png', new Uint8Array(0)))?.status).toBe(400)

    const oversized = await handleAssetRoutes(
      new Request('https://shuttle.test/sessions/run_a/assets?name=big.mp4', {
        method: 'POST',
        headers: { 'content-type': 'video/mp4', 'content-length': String(MAX_ASSET_BYTES + 1) },
        body: PNG,
      }),
      env,
      actor,
    )

    expect(oversized?.status).toBe(413)
    expect((await upload(fakeEnv(), 'run_a', 'a.png', PNG))?.status).toBe(503)
  })
})

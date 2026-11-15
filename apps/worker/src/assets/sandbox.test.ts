import { describe, expect, test } from 'bun:test'

import { fakeBucket } from '../testing/fake-r2'
import {
  attachmentManifest,
  attachmentPath,
  collectSharedFiles,
  shareDirectory,
  shareSandboxFile,
  stageAttachments,
} from './sandbox'
import { getAsset, putAsset } from './store'

const BYTES = new Uint8Array([1, 2, 3, 4, 5])

function memoryStorage() {
  const values = new Map<string, unknown>()

  return {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      values.set(key, value)
    },
  } as unknown as Pick<DurableObjectStorage, 'get' | 'put'>
}

describe('attachments in the sandbox', () => {
  test('a file has one path, safe for a shell, named in the manifest', () => {
    const asset = {
      id: 'ast_0123456789abcdef0123456789abcdef',
      name: 'My Shot (1).png',
      mediaType: 'image/png',
      size: 2048,
    }

    expect(attachmentPath('run_1', asset)).toBe(
      '/workspace/.shuttle/run_1/attachments/01234567-My_Shot__1_.png',
    )

    expect(attachmentManifest('run_1', [asset])).toBe(
      'Attached files, saved in the sandbox:\n- My Shot (1).png (image/png, 2 KB): /workspace/.shuttle/run_1/attachments/01234567-My_Shot__1_.png',
    )

    expect(attachmentManifest('run_1', [])).toBe('')
  })

  test('copies each file into a sandbox once', async () => {
    const bucket = fakeBucket()
    const storage = memoryStorage()
    const written: string[] = []

    const sandbox = {
      writeBytes: async (path: string, content: Uint8Array) => {
        written.push(`${path}:${content.byteLength}`)

        return { ok: true as const }
      },
    }

    const asset = await putAsset(bucket, 'run_1', {
      name: 'shot.png',
      mediaType: 'image/png',
      body: BYTES,
      source: 'upload',
      createdBy: 'user_1',
    })

    const stage = (sandboxName: string) =>
      stageAttachments({
        bucket,
        sandbox,
        sandboxName,
        storage,
        runId: 'run_1',
        attachments: [asset],
      })

    await stage('box_a')
    await stage('box_a')

    expect(written).toEqual([`${attachmentPath('run_1', asset)}:5`])

    // Another person's sandbox has not seen the file yet.
    await stage('box_b')

    expect(written).toHaveLength(2)
  })
})

function shareUnreadable(bytes: Uint8Array | null, size: number | null) {
  return shareSandboxFile({
    bucket: fakeBucket(),
    sandbox: { readBytes: async () => ({ bytes, size }) },
    runId: 'run_1',
    path: 'big.mp4',
    sharedBy: 'thr_worker',
  })
}

describe('sharing a sandbox file', () => {
  test('stores the file as session media with a type from its name', async () => {
    const bucket = fakeBucket()

    const result = await shareSandboxFile({
      bucket,
      sandbox: { readBytes: async () => ({ bytes: BYTES, size: 5 }) },
      runId: 'run_1',
      path: 'out/chart.png',
      sharedBy: 'thr_worker',
    })

    expect(result).toMatchObject({
      ok: true,
      asset: { name: 'chart.png', mediaType: 'image/png', size: 5, kind: 'image' },
    })

    const stored = result.ok ? await getAsset(bucket, 'run_1', result.asset.id) : null

    expect(stored?.object.customMetadata).toMatchObject({
      source: 'agent',
      createdBy: 'thr_worker',
    })
  })

  test('says why a file cannot be shared', async () => {
    expect(await shareUnreadable(null, null)).toEqual({
      ok: false,
      error: 'big.mp4 does not exist or is not a file.',
    })

    expect(await shareUnreadable(null, 80 * 1024 * 1024)).toEqual({
      ok: false,
      error: 'big.mp4 is 80.0 MB; files can be up to 50.0 MB.',
    })

    expect(
      await shareSandboxFile({
        bucket: undefined,
        sandbox: { readBytes: async () => ({ bytes: BYTES, size: 5 }) },
        runId: 'run_1',
        path: 'a.png',
        sharedBy: 'thr_worker',
      }),
    ).toMatchObject({ ok: false })
  })

  test('shares what a vendor agent left in the share directory, then clears it', async () => {
    const bucket = fakeBucket()
    const directory = shareDirectory('run_1')
    const commands: string[] = []

    const sandbox = {
      readBytes: async () => ({ bytes: BYTES, size: 5 }),
      exec: async (command: string) => {
        commands.push(command)

        return {
          stdout: command.includes('find') ? `${directory}/after.png\n${directory}/demo.mp4\n` : '',
          stderr: '',
          exitCode: 0,
        }
      },
    }

    const shared = await collectSharedFiles({
      bucket,
      sandbox,
      runId: 'run_1',
      sharedBy: 'thr_codex',
    })

    expect(shared.map(({ result }) => (result.ok ? result.asset.kind : 'failed'))).toEqual([
      'image',
      'video',
    ])

    expect(commands.at(-1)).toBe(`rm -f -- '${directory}/after.png' '${directory}/demo.mp4'`)
    expect(bucket.keys()).toHaveLength(2)
  })
})

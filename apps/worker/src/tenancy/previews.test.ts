import { describe, expect, test } from 'bun:test'

import { parsePreviewHost } from '../sandbox/preview-host'
import { migratedD1 } from '../testing/fake-d1'
import { isPreviewKey, previewKeyFor, runOfPreviewKey } from './previews'

describe('preview keys', () => {
  test('a session has one key, which leads back to it', async () => {
    const db = await migratedD1()
    const key = await previewKeyFor(db, 'o-orgA-session_1')

    expect(isPreviewKey(key)).toBe(true)
    expect(await previewKeyFor(db, 'o-orgA-session_1')).toBe(key)
    expect(await runOfPreviewKey(db, key)).toBe('o-orgA-session_1')
  })

  test('each session has its own', async () => {
    const db = await migratedD1()

    expect(await previewKeyFor(db, 'o-orgA-session_1')).not.toBe(
      await previewKeyFor(db, 'o-orgA-session_2'),
    )
  })

  test('a key works as the label of a preview hostname', async () => {
    const db = await migratedD1()
    const key = await previewKeyFor(db, 'o-orgA-session_1')

    expect(parsePreviewHost(`p3000-${key}.preview.example`)).toEqual({ port: 3000, folderId: key })
  })

  test('anything else leads nowhere', async () => {
    const db = await migratedD1()
    await previewKeyFor(db, 'o-orgA-session_1')

    expect(await runOfPreviewKey(db, 'a'.repeat(24))).toBeNull()
    // A folder id or a run id is never a key.
    expect(await runOfPreviewKey(db, 'o-orgA-session_1')).toBeNull()
    expect(await runOfPreviewKey(db, '3f2a9c1e-7b64-4d0a-9c1e-3f2a9c1e7b64')).toBeNull()
  })
})

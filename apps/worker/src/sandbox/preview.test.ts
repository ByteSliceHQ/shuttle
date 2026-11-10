import { describe, expect, test } from 'bun:test'

import { parsePreviewHost } from './preview-host'

describe('parsePreviewHost', () => {
  test('parses port and folder label from preview hostnames', () => {
    expect(parsePreviewHost('p3000-abc123.localhost')).toEqual({
      port: 3000,
      folderId: 'abc123',
    })

    expect(parsePreviewHost('p5173-folder-id.preview.example.com')).toEqual({
      port: 5173,
      folderId: 'folder-id',
    })
  })

  test('rejects invalid hosts', () => {
    expect(parsePreviewHost('localhost')).toBeNull()
    expect(parsePreviewHost('p99999-abc.localhost')).toBeNull()
    expect(parsePreviewHost('preview.example.com')).toBeNull()
  })
})

import { describe, expect, test } from 'bun:test'

import { loopbackPreviewPort, patchOf, previewUrl, resolveBrowserTarget } from './sandbox'

describe('resolveBrowserTarget', () => {
  const folderId = '9f0a7be4-4c4c-4bdc-8c3f-c9e93a7951db'
  const label = '9f0a7be4-4c4c-4bdc-8c3f-c9e93a7951db'

  test('rewrites bare ports and localhost URLs to the preview host', () => {
    const portSuffix = import.meta.env.DEV ? ':8790' : ''

    expect(resolveBrowserTarget('3000', folderId, 'localhost')).toBe(
      `http://p3000-${label}.localhost${portSuffix}`,
    )

    expect(resolveBrowserTarget('http://localhost:3000', folderId, 'localhost')).toBe(
      `http://p3000-${label}.localhost${portSuffix}`,
    )

    expect(resolveBrowserTarget('127.0.0.1:5173', folderId, 'localhost')).toBe(
      `http://p5173-${label}.localhost${portSuffix}`,
    )

    expect(resolveBrowserTarget('http://[::1]:8080/', folderId, 'localhost')).toBe(
      `http://p8080-${label}.localhost${portSuffix}`,
    )
  })

  test('leaves non-loopback URLs unchanged', () => {
    expect(resolveBrowserTarget('https://example.com', folderId)).toBe('https://example.com')
    expect(resolveBrowserTarget('example.com', folderId)).toBe('http://example.com')
  })

  test('loopbackPreviewPort parses common forms', () => {
    expect(loopbackPreviewPort('3000')).toBe(3000)
    expect(loopbackPreviewPort('localhost:3000')).toBe(3000)
    expect(loopbackPreviewPort('http://127.0.0.1:4000/path')).toBe(4000)
    expect(loopbackPreviewPort('https://example.com:443')).toBeNull()
  })
})

describe('previewUrl', () => {
  const folderId = 'df0984d0-45a3-497e-a51a-3d2fc170d3e6'

  test('uses a localhost subdomain when the app is opened on a loopback address', () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      const url = new URL(previewUrl(4067, folderId, host))

      expect(url.hostname).toBe(`p4067-${folderId}.localhost`)
    }
  })

  test('keeps a real preview host', () => {
    expect(new URL(previewUrl(3000, folderId, 'preview.example.com')).hostname).toBe(
      `p3000-${folderId}.preview.example.com`,
    )
  })

  test('follows the page onto https, and stays on http on this machine', () => {
    const scope = globalThis as { window?: unknown }
    const before = scope.window

    scope.window = { location: { protocol: 'https:', hostname: 'app.shuttle.example', port: '' } }

    try {
      expect(previewUrl(3000, folderId, 'shuttle.example')).toBe(
        `https://p3000-${folderId}.shuttle.example`,
      )

      expect(new URL(previewUrl(3000, folderId, 'localhost')).protocol).toBe('http:')
    } finally {
      scope.window = before
    }
  })
})

describe('patchOf', () => {
  test("is the file's own patch when one file was asked about", () => {
    expect(patchOf({ source: 'sandbox', path: 'app/a.ts', diff: 'diff --git a b' })).toBe(
      'diff --git a b',
    )
  })

  test("joins every repository's patch when none was", () => {
    expect(
      patchOf({
        source: 'saved',
        diffs: [
          { cwd: '/workspace/app', name: 'app', diff: 'one' },
          { cwd: '/workspace/lib', name: 'lib', diff: 'two' },
        ],
      }),
    ).toBe('one\ntwo')

    expect(patchOf({ source: 'asleep', diffs: [] })).toBe('')
  })
})

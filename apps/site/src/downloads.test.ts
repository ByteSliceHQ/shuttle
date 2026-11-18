import { expect, test } from 'bun:test'

import site, { releaseName, type SiteEnv } from './index'

const heads: string[] = []
const gets: string[] = []

interface Pointer {
  readonly file?: string
}

function isPointer(value: unknown): value is Pointer {
  return typeof value === 'object' && value !== null
}

/** The pointer file's JSON, as the bucket's `json()` would answer. */
function pointer(text: string): Pointer {
  const value: unknown = JSON.parse(text)

  if (!isPointer(value)) {
    throw new Error('Not a pointer file.')
  }

  return value
}

function env(objects: Record<string, string>): SiteEnv {
  return {
    LATEST_MAC: 'Shuttle-0.0.1-arm64.dmg',
    // SAFETY: the worker under test only calls `fetch` on the assets binding.
    ASSETS: { fetch: async () => new Response('page') } as never,
    // SAFETY: the worker under test only calls `head` and `get` on the bucket, and the fakes
    // below answer with the fields it reads.
    RELEASES: {
      head: async (name: string) => {
        heads.push(name)
        const value = objects[name]
        return value === undefined
          ? null
          : {
              size: new TextEncoder().encode(value).length,
              httpEtag: '"release"',
              writeHttpMetadata: () => {},
            }
      },
      get: async (name: string) => {
        gets.push(name)
        const value = objects[name]
        return value === undefined
          ? null
          : {
              body: new Response(value).body,
              size: new TextEncoder().encode(value).length,
              httpEtag: '"release"',
              writeHttpMetadata: (headers: Headers) =>
                headers.set(
                  'content-type',
                  name.endsWith('.yml') ? 'application/yaml' : 'application/octet-stream',
                ),
              text: async () => value,
              json: async () => pointer(value),
            }
      },
    } as never,
  }
}

const manifest =
  'version: 0.1.20\nfiles:\n  - url: Shuttle-0.1.20-arm64.zip\n    sha512: zip-hash\n  - url: Shuttle-0.1.20-arm64.dmg\n    sha512: dmg-hash\n'

test('serves updater metadata without caching and versioned files with caching', async () => {
  const bindings = env({ 'latest-mac.yml': manifest, 'Shuttle-0.1.20-arm64.zip': 'zip' })

  const metadata = await site.fetch(
    new Request('https://shuttle.codes/download/latest-mac.yml'),
    bindings,
  )

  expect(metadata.status).toBe(200)
  expect(metadata.headers.get('cache-control')).toBe('no-store')
  expect(await metadata.text()).toBe(manifest)

  const binary = await site.fetch(
    new Request('https://shuttle.codes/download/Shuttle-0.1.20-arm64.zip'),
    bindings,
  )

  expect(binary.headers.get('cache-control')).toContain('max-age=')

  const head = await site.fetch(
    new Request('https://shuttle.codes/download/Shuttle-0.1.20-arm64.zip', { method: 'HEAD' }),
    bindings,
  )

  expect(await head.text()).toBe('')
  expect(head.headers.get('content-length')).toBe('3')
  expect(heads).toEqual(['Shuttle-0.1.20-arm64.zip'])
  expect(gets.filter((name) => name === 'Shuttle-0.1.20-arm64.zip')).toHaveLength(1)
})

test('download button follows the manual download pointer and retains its initial fallback', async () => {
  const request = new Request('https://shuttle.codes/download/mac')

  expect(
    (
      await site.fetch(
        request,
        env({ 'latest-mac.json': JSON.stringify({ file: 'Shuttle-0.1.20-arm64.dmg' }) }),
      )
    ).headers.get('location'),
  ).toBe('https://shuttle.codes/download/Shuttle-0.1.20-arm64.dmg')

  expect((await site.fetch(request, env({}))).headers.get('location')).toBe(
    'https://shuttle.codes/download/Shuttle-0.0.1-arm64.dmg',
  )
})

test('only exposes the update manifest and plain release filenames', () => {
  expect(releaseName('/download/latest-mac.yml')).toBe('latest-mac.yml')

  expect(releaseName('/download/Shuttle-0.1.20-arm64.zip.blockmap')).toBe(
    'Shuttle-0.1.20-arm64.zip.blockmap',
  )

  for (const name of ['secret.yml', '../latest-mac.yml', 'a/b.zip', '.env']) {
    expect(releaseName(`/download/${name}`)).toBeNull()
  }
})

test('manual download pointer rejects paths outside versioned DMGs', async () => {
  const request = new Request('https://shuttle.codes/download/mac')

  for (const file of ['../secret.dmg', 'https://evil.example/app.dmg', 'notes.txt']) {
    const response = await site.fetch(request, env({ 'latest-mac.json': JSON.stringify({ file }) }))

    expect(response.headers.get('location')).toBe(
      'https://shuttle.codes/download/Shuttle-0.0.1-arm64.dmg',
    )
  }

  const response = await site.fetch(
    new Request('https://shuttle.codes/download/latest-mac.json'),
    env({ 'latest-mac.json': '{}' }),
  )

  expect(response.headers.get('cache-control')).toBe('no-store')
})

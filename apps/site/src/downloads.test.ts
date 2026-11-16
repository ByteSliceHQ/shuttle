import { expect, test } from 'bun:test'

import site, { releaseName, type SiteEnv } from './index'

function env(objects: Record<string, string>): SiteEnv {
  return {
    LATEST_MAC: 'Shuttle-0.0.1-arm64.dmg',
    ASSETS: { fetch: async () => new Response('page') } as unknown as Fetcher,
    RELEASES: {
      get: async (name: string) => {
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
            }
      },
    } as unknown as R2Bucket,
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
})

test('download button follows the published manifest and retains its initial fallback', async () => {
  const request = new Request('https://shuttle.codes/download/mac')

  expect(
    (await site.fetch(request, env({ 'latest-mac.yml': manifest }))).headers.get('location'),
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

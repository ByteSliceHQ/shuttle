import { describe, expect, test } from 'bun:test'

import {
  asHeadResponse,
  previewUnavailableResponse,
  upstreamMethodFor,
  wantsHtmlErrorPage,
} from './preview-proxy'

describe('preview proxy helpers', () => {
  test('upgrades HEAD to GET for the container hop', () => {
    expect(upstreamMethodFor(new Request('http://x/', { method: 'HEAD' }))).toBe('GET')
    expect(upstreamMethodFor(new Request('http://x/', { method: 'GET' }))).toBe('GET')
    expect(upstreamMethodFor(new Request('http://x/', { method: 'POST' }))).toBe('POST')
  })

  test('asHeadResponse drops the body but keeps status and headers', async () => {
    const upstream = new Response('huge payload', {
      status: 200,
      headers: { 'content-type': 'text/javascript', etag: '"abc"' },
    })

    const head = asHeadResponse(upstream)

    expect(head.status).toBe(200)
    expect(head.headers.get('content-type')).toBe('text/javascript')
    expect(head.headers.get('etag')).toBe('"abc"')
    expect(await head.text()).toBe('')
  })

  test('HTML error pages only for document-like accepts', () => {
    expect(
      wantsHtmlErrorPage(
        new Request('http://x/', { headers: { accept: 'text/html,application/xhtml+xml' } }),
      ),
    ).toBe(true)

    expect(
      wantsHtmlErrorPage(
        new Request('http://x/@vite/client', {
          headers: { accept: '*/*', 'sec-fetch-dest': 'script' },
        }),
      ),
    ).toBe(false)
  })

  test('module fetches get a plain 503 instead of an HTML shell', async () => {
    const response = previewUnavailableResponse(
      new Request('http://x/@vite/client', {
        headers: { accept: '*/*', 'sec-fetch-dest': 'script' },
      }),
      5173,
      'container is not listening',
    )

    expect(response.status).toBe(503)
    expect(response.headers.get('content-type')).toMatch(/text\/plain/)
    expect(response.headers.get('retry-after')).toBe('2')
    expect(await response.text()).toContain('5173')
  })

  test('documents get a page that names the port and nothing about where the sandbox runs', async () => {
    const response = previewUnavailableResponse(
      new Request('http://x/', { headers: { accept: 'text/html', 'sec-fetch-dest': 'iframe' } }),
      8000,
    )

    const page = await response.text()

    expect(response.status).toBe(503)
    expect(response.headers.get('content-type')).toMatch(/text\/html/)
    expect(response.headers.get('x-preview-unavailable')).toBe('1')
    expect(page).toContain('Nothing is running on port 8000')
    expect(page.toLowerCase()).not.toContain('daytona')
    expect(page).not.toContain('<pre>')
  })
})

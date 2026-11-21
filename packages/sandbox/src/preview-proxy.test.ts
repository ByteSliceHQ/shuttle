import { describe, expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'

import {
  PREVIEW_POLL_MAX_MS,
  PREVIEW_POLL_START_MS,
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

/** The script the unavailable page carries, so a test can run it against a fake tab. */
async function unavailablePageScript(): Promise<string> {
  const response = previewUnavailableResponse(
    new Request('http://x/', { headers: { accept: 'text/html', 'sec-fetch-dest': 'iframe' } }),
    3000,
  )

  const html = await response.text()
  const script = /<script>([\s\S]+)<\/script>/.exec(html)?.[1]

  if (script === undefined) {
    throw new Error('the unavailable page carries no script')
  }

  return script
}

/** Lets the promise chain one poll starts settle before a test reads what it scheduled. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn++) {
    await Promise.resolve()
  }
}

/**
 * Runs the page's script against a fake tab. It records every wait the script asks for, and lets a
 * test fire the pending timer or change the tab's visibility.
 */
function fakeTab(script: string, portAnswers: boolean) {
  const waits: number[] = []
  const timers = new Map<number, () => void>()
  let reloads = 0
  let hidden = false
  let onVisibilityChange: (() => void) | undefined
  let lastId = 0

  const document = {
    get hidden() {
      return hidden
    },
    addEventListener(type: string, listener: () => void) {
      if (type === 'visibilitychange') {
        onVisibilityChange = listener
      }
    },
  }

  const location = {
    href: 'https://p3000-test.shuttle.codes/',
    reload() {
      reloads += 1
    },
  }

  const setTimeoutOfTab = (run: () => void, ms: number) => {
    waits.push(ms)
    lastId += 1
    timers.set(lastId, run)

    return lastId
  }

  const clearTimeoutOfTab = (id: number) => {
    timers.delete(id)
  }

  const fetchOfTab = () => Promise.resolve({ headers: { get: () => (portAnswers ? null : '1') } })

  runInNewContext(script, {
    document,
    location,
    fetch: fetchOfTab,
    setTimeout: setTimeoutOfTab,
    clearTimeout: clearTimeoutOfTab,
  })

  return {
    waits,
    pending(): number {
      return timers.size
    },
    reloads(): number {
      return reloads
    },
    async tick(): Promise<void> {
      const pending = [...timers.entries()][0]

      if (pending === undefined) {
        throw new Error('no timer is pending')
      }

      timers.delete(pending[0])
      pending[1]()
      await settle()
    },
    visible(visible: boolean): void {
      hidden = !visible
      onVisibilityChange?.()
    },
  }
}

describe('preview unavailable page', () => {
  test('backs the poll off as the port stays down', async () => {
    const tab = fakeTab(await unavailablePageScript(), false)

    for (let poll = 0; poll < 6; poll++) {
      await tab.tick()
    }

    expect(tab.waits).toEqual([
      PREVIEW_POLL_START_MS,
      PREVIEW_POLL_START_MS * 2,
      PREVIEW_POLL_START_MS * 4,
      PREVIEW_POLL_START_MS * 8,
      PREVIEW_POLL_MAX_MS,
      PREVIEW_POLL_MAX_MS,
      PREVIEW_POLL_MAX_MS,
    ])
  })

  test('stops polling while the tab is hidden and resumes when it shows', async () => {
    const tab = fakeTab(await unavailablePageScript(), false)

    await tab.tick()
    await tab.tick()

    tab.visible(false)
    expect(tab.pending()).toBe(0)

    tab.visible(true)
    expect(tab.waits.at(-1)).toBe(PREVIEW_POLL_START_MS)
    expect(tab.pending()).toBe(1)
  })

  test('reloads once the port answers instead of polling again', async () => {
    const tab = fakeTab(await unavailablePageScript(), true)

    await tab.tick()

    expect(tab.reloads()).toBe(1)
    expect(tab.pending()).toBe(0)
    expect(tab.waits).toEqual([PREVIEW_POLL_START_MS])
  })
})

/*
 * Keeps Shuttle's own page and scripts on the device, so the app opens without waiting on the
 * network. Only the app's files are kept: every API call, sign-in and event stream goes straight
 * to the Worker, untouched.
 *
 * The page is answered from the last copy kept and refreshed in the background, so a new
 * deployment shows on the load after it lands. When a refresh brings a different page, open
 * windows are told, and they reload the next time they are out of sight.
 */
const CACHE = 'shuttle-shell-v1'
const PAGE = '/'

/** Paths that are never the app's page, even when a browser navigates to them. */
const NEVER_A_PAGE = ['/github', '/api/auth', '/auth', '/health']

const under = (pathname, prefixes) =>
  prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))

/** The scripts and styles a page names, which are kept alongside it. */
const assetsOf = (html) => [...new Set(html.match(/\/assets\/[A-Za-z0-9._-]+/g) ?? [])]

/** Fetches the page and keeps it and what it names. Answers whether it differs from the last. */
async function refreshPage() {
  const cache = await caches.open(CACHE)
  const response = await fetch(PAGE, { cache: 'no-store', credentials: 'same-origin' })

  if (!response.ok || !(response.headers.get('content-type') ?? '').includes('text/html')) {
    return false
  }

  const html = await response.clone().text()
  const previous = await cache.match(PAGE)
  const changed = previous ? (await previous.text()) !== html : false

  // The scripts go in first: a page must never be kept without what it needs to run.
  await Promise.all(
    assetsOf(html).map(async (file) => {
      if (!(await cache.match(file))) {
        await cache.add(file)
      }
    }),
  )

  await cache.put(PAGE, response)

  return changed
}

self.addEventListener('install', (event) => {
  event.waitUntil(refreshPage().then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  )
})

async function page() {
  const cache = await caches.open(CACHE)
  const kept = await cache.match(PAGE)

  const refreshed = refreshPage()
    .then(async (changed) => {
      if (changed) {
        for (const client of await self.clients.matchAll({ type: 'window' })) {
          // A service worker's client takes no target origin: it is always this origin.
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a service worker client has no target origin; postMessage on it is always same-origin
          client.postMessage({ type: 'shuttle:shell-updated' })
        }
      }
    })
    .catch(() => {})

  if (kept) {
    return kept
  }

  await refreshed

  return (await cache.match(PAGE)) ?? fetch(PAGE)
}

/** Built files carry a hash of their contents in their name, so a kept copy is never stale. */
async function asset(request) {
  const cache = await caches.open(CACHE)
  const kept = await cache.match(request)

  if (kept) {
    return kept
  }

  const response = await fetch(request)

  if (response.ok) {
    await cache.put(request, response.clone())
  }

  return response
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  if (request.method !== 'GET' || url.origin !== self.location.origin) {
    return
  }

  if (request.mode === 'navigate') {
    if (!under(url.pathname, NEVER_A_PAGE)) {
      event.respondWith(page().catch(() => fetch(request)))
    }

    return
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(asset(request))
  }
})

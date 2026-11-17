/**
 * Registers the service worker that keeps Shuttle's page and scripts on the device (see
 * `public/sw.js`). Only a built app has one: in development Vite serves modules that change
 * under the page, and keeping them would show stale code.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) {
    return
  }

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })

  // A new deployment was fetched behind this page. Reloading under someone's hands would lose
  // what they are typing, so the page waits until it is out of sight.
  let stale = false

  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const data: unknown = event.data

    if (
      data &&
      typeof data === 'object' &&
      'type' in data &&
      data.type === 'shuttle:shell-updated'
    ) {
      stale = true
    }
  })

  document.addEventListener('visibilitychange', () => {
    if (stale && document.visibilityState === 'hidden') {
      window.location.reload()
    }
  })
}

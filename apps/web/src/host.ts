import { desktop } from '@/features/desktop/desktop'
import { storeTimings } from '@/lib/timing'
import { createShuttleHost } from '@shuttle/react'

/**
 * How Shuttle's own app reaches its Worker, which serves it on the same origin, and the desktop
 * app's machine when the page is inside one. Route loaders and `<Shuttle.Provider>` share it.
 */
export const host = createShuttleHost({
  device: desktop(),
  // In development Vite serves the page and passes the API on to the Worker, but a preview is
  // a subdomain of the Worker itself.
  previewPort: import.meta.env.DEV
    ? (import.meta.env.VITE_SHUTTLE_WORKER_PORT ?? '8790')
    : undefined,
  fixtures: import.meta.env.DEV,
  runStore: () => ({ observer: storeTimings }),
})

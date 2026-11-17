import { desktop } from '@/features/desktop/desktop'
import { storeTimings } from '@/lib/timing'
import { createShuttleHost } from '@shuttle/react'

/**
 * How Shuttle's own app reaches its Worker, which serves it on the same origin, and the desktop
 * app's machine when the page is inside one. Route loaders and `<Shuttle.Provider>` share it.
 */
export const host = createShuttleHost({
  device: desktop(),
  runStore: () => ({ observer: storeTimings }),
})

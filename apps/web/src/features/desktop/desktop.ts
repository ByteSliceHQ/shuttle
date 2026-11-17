import { type ShuttleDevice } from '@shuttle/react'

/**
 * The Shuttle desktop app, as the page sees it. The app's preload script puts this on `window`;
 * in a browser it is absent, and everything that depends on it stays out of the way.
 */
export type { DeviceRunnerStatus as DesktopRunnerStatus } from '@shuttle/react'

export type ShuttleDesktop = ShuttleDevice

declare global {
  interface Window {
    readonly shuttleDesktop?: ShuttleDesktop
  }
}

export function desktop(): ShuttleDesktop | null {
  return typeof window === 'undefined' ? null : (window.shuttleDesktop ?? null)
}

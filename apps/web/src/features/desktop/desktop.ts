import { type ShuttleDevice } from '@shuttle/react'

/**
 * The Shuttle desktop app, as the page sees it. The app's preload script puts this on `window`;
 * in a browser it is absent, and everything that depends on it stays out of the way.
 */
export type { DeviceRunnerStatus as DesktopRunnerStatus } from '@shuttle/react'

/** Where the desktop app's own updater is. Only Developer ID builds install updates themselves. */
export interface DesktopUpdateStatus {
  readonly status:
    | 'manual'
    | 'disabled'
    | 'idle'
    | 'checking'
    | 'current'
    | 'available'
    | 'downloading'
    | 'ready'
    | 'error'
  readonly version: string
  readonly nextVersion?: string
  readonly progress?: number
  readonly message?: string
}

/**
 * The app's updater came with a later build, so an older one that is still installed does not
 * have it. Ask before calling.
 */
export interface DesktopUpdater {
  updateStatus?(): Promise<DesktopUpdateStatus>
  checkForUpdates?(): Promise<void>
  downloadUpdate?(): Promise<void>
  installUpdate?(): Promise<void>
  onUpdateStatus?(listener: (status: DesktopUpdateStatus) => void): () => void
}

/** The app's own release, such as `0.1.142`. An app older than this field does not say. */
export interface DesktopVersion {
  readonly version?: string
}

export type ShuttleDesktop = ShuttleDevice & DesktopUpdater & DesktopVersion

declare global {
  interface Window {
    readonly shuttleDesktop?: ShuttleDesktop
  }
}

export function desktop(): ShuttleDesktop | null {
  return typeof window === 'undefined' ? null : (window.shuttleDesktop ?? null)
}

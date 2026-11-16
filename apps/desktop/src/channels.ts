/** What the page and the app say to each other. The page only ever sees `preload.ts`'s bridge. */
export const CHANNELS = {
  /** Sync. Answers with `DesktopInfo`. */
  info: 'desktop:info',
  updateStatus: 'desktop:update-status',
  updateStatusChanged: 'desktop:update-status-changed',
  checkForUpdates: 'desktop:check-for-updates',
  downloadUpdate: 'desktop:download-update',
  installUpdate: 'desktop:install-update',
  /** Invoke. Answers with the runner's last `RunnerStatus`. */
  runnerStatus: 'desktop:runner-status',
  /** Invoke. Answers whether a new session starts on this machine. */
  startsLocally: 'desktop:starts-locally',
  /** Sent to the page whenever the runner's status changes. */
  runnerStatusChanged: 'desktop:runner-status-changed',
} as const

export interface DesktopInfo {
  readonly deviceId: string
  readonly deviceName: string
  readonly platform: string
}

export interface RunnerStatus {
  readonly status:
    | 'starting'
    | 'preparing'
    | 'connecting'
    | 'online'
    | 'offline'
    | 'unauthorized'
    | 'error'
  readonly message?: string
  readonly backend?: { readonly id: string; readonly label: string; readonly isolation: string }
}

export interface UpdateStatus {
  readonly status:
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

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
  /** From the page: how many sessions are waiting on this person, for the Dock. */
  setBadge: 'desktop:set-badge',
  /** From the page: something happened in a session that is not on screen. */
  notify: 'desktop:notify',
  /** Sent to the page to take it somewhere: a menu item, a notification, a `shuttle://` link. */
  navigate: 'desktop:navigate',
} as const

/** A system notification the page asks for. Clicking it opens `path` in the app. */
export interface DesktopNotice {
  readonly title: string
  readonly body: string
  readonly path?: string
}

/**
 * A place inside the app, as a path the page's router understands. Anything else is refused, so
 * a link or a notification can never send the window to another site.
 */
export function appPath(value: unknown): string | null {
  return typeof value === 'string' && /^\/(?!\/)[A-Za-z0-9\-._~%!$&'()*+,;=:@/?]*$/.test(value)
    ? value
    : null
}

/** The path a `shuttle://` link names: `shuttle://sessions/<id>` is `/sessions/<id>`. */
export function deepLinkPath(link: string): string | null {
  if (!link.startsWith('shuttle://')) {
    return null
  }

  return appPath(`/${link.slice('shuttle://'.length).replace(/^\/+/, '')}`)
}

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

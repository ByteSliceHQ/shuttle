/**
 * The Shuttle desktop app, as the page sees it. The app's preload script puts this on `window`;
 * in a browser it is absent, and everything that depends on it stays out of the way.
 */
export interface ShuttleDesktop {
  /** Names this machine's sandbox. Stable across launches. */
  readonly deviceId: string
  readonly deviceName: string
  readonly platform: string
  /** What the app's runner last reported, such as `online` or `preparing`. */
  runnerStatus(): Promise<DesktopRunnerStatus>
  /** Whether a new session starts on this machine. A setting in the app's Sandbox menu. */
  startsLocally(): Promise<boolean>
  /** Calls back whenever that changes. Returns a function that stops it. */
  onRunnerStatus(listener: (status: DesktopRunnerStatus) => void): () => void
  /**
   * The rest came with a later build of the app, so an older one that is still installed does
   * not have them. Ask before calling.
   */
  /** How many sessions are waiting on this person, shown on the app's Dock icon. */
  setBadge?(count: number): void
  /** A system notification. Clicking it opens `path` in the app. */
  notify?(notice: { title: string; body: string; path?: string }): void
  /** Calls back when the app wants the page somewhere: a menu item, a notification, a link. */
  onNavigate?(listener: (path: string) => void): () => void
}

export interface DesktopRunnerStatus {
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

declare global {
  interface Window {
    readonly shuttleDesktop?: ShuttleDesktop
  }
}

export function desktop(): ShuttleDesktop | null {
  return typeof window === 'undefined' ? null : (window.shuttleDesktop ?? null)
}

/**
 * What a call sends so the Worker answers for this machine's sandbox as well as the cloud. From
 * a browser there is no machine, and the call is about the cloud alone.
 */
export function deviceContext(): { readonly deviceId: string | null } {
  return { deviceId: desktop()?.deviceId ?? null }
}

const ISOLATION: Record<string, string> = {
  microvm: 'in its own virtual machine',
  vm: 'in a virtual machine',
  container: 'in a container',
  process: 'as a sandboxed process',
}

/** How a local sandbox is kept apart from the machine, in a few words. */
export function isolationLabel(isolation: string | undefined): string {
  return (isolation && ISOLATION[isolation]) || 'in a sandbox'
}

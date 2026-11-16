/**
 * The Shuttle desktop app, as the page sees it. The app's preload script puts this on `window`;
 * in a browser it is absent, and everything that depends on it stays out of the way.
 */
export interface ShuttleDesktop {
  /** Names this machine's sandbox. Stable across launches. */
  readonly deviceId: string
  readonly deviceName: string
  readonly platform: string
  updateStatus?(): Promise<DesktopUpdateStatus>
  checkForUpdates?(): Promise<void>
  downloadUpdate?(): Promise<void>
  installUpdate?(): Promise<void>
  onUpdateStatus?(listener: (status: DesktopUpdateStatus) => void): () => void
  /** What the app's runner last reported, such as `online` or `preparing`. */
  runnerStatus(): Promise<DesktopRunnerStatus>
  /** Whether a new session starts on this machine. A setting in the app's Sandbox menu. */
  startsLocally(): Promise<boolean>
  /** Calls back whenever that changes. Returns a function that stops it. */
  onRunnerStatus(listener: (status: DesktopRunnerStatus) => void): () => void
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

export interface DesktopUpdateStatus {
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

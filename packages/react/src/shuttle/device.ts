/**
 * The machine Shuttle is running on, when it has one: a desktop app with a runner that keeps a
 * sandbox on the device. A host with no machine (a browser tab, another product's page) leaves
 * it out, and everything that depends on it stays out of the way.
 */
export interface ShuttleDevice {
  /** Names this machine's sandbox. Stable across launches. */
  readonly deviceId: string
  readonly deviceName: string
  readonly platform: string
  /** What the app's runner last reported, such as `online` or `preparing`. */
  runnerStatus(): Promise<DeviceRunnerStatus>
  /** Whether a new session starts on this machine. A setting in the app's Sandbox menu. */
  startsLocally(): Promise<boolean>
  /** Calls back whenever that changes. Returns a function that stops it. */
  onRunnerStatus(listener: (status: DeviceRunnerStatus) => void): () => void
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

export interface DeviceRunnerStatus {
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

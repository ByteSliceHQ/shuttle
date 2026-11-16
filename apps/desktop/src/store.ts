import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * What the app remembers between launches, as one small JSON file in its data folder. Nothing in
 * it is a secret in the clear: a machine token is stored encrypted by the operating system's
 * keychain (see `machine.ts`).
 */
export interface AppState {
  /** Names this machine's sandbox. Not secret, and not the hardware's. */
  deviceId?: string
  window?: { x?: number; y?: number; width: number; height: number; maximized?: boolean }
  /** Whether a new session starts on this machine when its sandbox is up. On unless turned off. */
  startLocally?: boolean
  /** This machine's token for each Shuttle it has connected to, by origin. */
  machines?: Record<string, { userId: string; orgId: string; token: string; encrypted: boolean }>
}

export class Store {
  private state: AppState

  constructor(private readonly file: string) {
    try {
      this.state = JSON.parse(readFileSync(file, 'utf8')) as AppState
    } catch {
      this.state = {}
    }
  }

  get<Key extends keyof AppState>(key: Key): AppState[Key] {
    return this.state[key]
  }

  set<Key extends keyof AppState>(key: Key, value: AppState[Key]): void {
    this.state = { ...this.state, [key]: value }
    mkdirSync(dirname(this.file), { recursive: true })
    // Readable by this account only.
    writeFileSync(this.file, JSON.stringify(this.state, null, 2), { mode: 0o600 })
  }
}

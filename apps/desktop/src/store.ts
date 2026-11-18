import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { z } from 'zod'

/**
 * What the app remembers between launches, as one small JSON file in its data folder. Nothing in
 * it is a secret in the clear: a machine token is stored encrypted by the operating system's
 * keychain (see `machine.ts`).
 */
const machineSchema = z.object({
  userId: z.string(),
  orgId: z.string(),
  token: z.string(),
  encrypted: z.boolean(),
})

/**
 * Each key is read on its own, so one that cannot be read (written by another version, or edited)
 * is dropped without taking the device's identity and its machine tokens with it.
 */
const appStateSchema = z
  .object({
    /** Names this machine's sandbox. Not secret, and not the hardware's. */
    deviceId: z.string().optional().catch(undefined),
    window: z
      .object({
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number(),
        height: z.number(),
        maximized: z.boolean().optional(),
      })
      .optional()
      .catch(undefined),
    /** Whether a new session starts on this machine when its sandbox is up. On unless turned off. */
    startLocally: z.boolean().optional().catch(undefined),
    /** This machine's token for each Shuttle it has connected to, by origin. */
    machines: z
      .record(z.string(), z.unknown())
      .transform((entries) =>
        Object.fromEntries(
          Object.entries(entries).flatMap(([origin, value]) => {
            const machine = machineSchema.safeParse(value)

            return machine.success ? [[origin, machine.data]] : []
          }),
        ),
      )
      .optional()
      .catch(undefined),
  })
  .catch({})

export type AppState = z.infer<typeof appStateSchema>

export class Store {
  private state: AppState

  constructor(private readonly file: string) {
    try {
      this.state = appStateSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
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

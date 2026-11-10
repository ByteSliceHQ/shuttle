import type { ShuttleEnv } from './src/env'

declare global {
  interface Env extends ShuttleEnv {}
}

export type { ShuttleEnv }

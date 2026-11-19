import { fakeEnv as fakeEngineEnv } from '@shuttle/engine/testing/fake-env'

import type { ShuttleEnv } from '../env'

/** A ShuttleEnv for unit tests. Its Durable Object bindings throw if a test reaches them. */
export function fakeEnv(overrides: Partial<ShuttleEnv> = {}): ShuttleEnv {
  return { ...fakeEngineEnv(), ...overrides }
}

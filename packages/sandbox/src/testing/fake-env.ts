import type { SandboxEnv } from '../env'

/** A SandboxEnv for unit tests: nothing is configured unless the test sets it. */
export function fakeEnv(overrides: SandboxEnv = {}): SandboxEnv {
  return { ...overrides }
}

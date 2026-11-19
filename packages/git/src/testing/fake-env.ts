import type { GitEnv } from '../env'

/** A GitEnv for unit tests: nothing is configured unless the test sets it. */
export function fakeEnv(overrides: GitEnv = {}): GitEnv {
  return { ...overrides }
}

import { describe, expect, test } from 'bun:test'

import type { SessionAccess } from '../tenancy/access'
import { scopedRunId } from '../tenancy/run-id'
import { fakeEnv } from '../testing/fake-env'
import { mayShareLessons } from './sharing'

const session = scopedRunId('orgA0000000000000000000000000000', 'session_1')

function envWith(access: SessionAccess | null) {
  return fakeEnv({
    // SAFETY: `mayShareLessons` only calls `getByName(...).getAccess()` on the run namespace.
    LOOMS_RUN: { getByName: () => ({ getAccess: async () => access }) as never },
  })
}

describe('mayShareLessons', () => {
  test("a private session's lessons stay out of the shared playbook", async () => {
    const env = envWith({ ownerId: 'alice', memberIds: ['bob'], visibility: 'private' })

    expect(await mayShareLessons(env, session)).toBe(false)
  })

  test('a public session, or one Shuttle started, may add to it', async () => {
    expect(
      await mayShareLessons(
        envWith({ ownerId: 'alice', memberIds: [], visibility: 'public' }),
        session,
      ),
    ).toBe(true)

    expect(await mayShareLessons(envWith(null), session)).toBe(true)
  })

  test('a run with no organization is not asked', async () => {
    // The env would throw if the run were looked up.
    expect(await mayShareLessons(fakeEnv(), 'session_1')).toBe(true)
  })
})

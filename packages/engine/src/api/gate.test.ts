import { describe, expect, test } from 'bun:test'

import { describeRoute, type AuthDecision } from '@swirls/looms/runtime'

import type { Actor, SessionAccess } from '../tenancy/access'
import { personalRunId, reflectionRunId, scopedRunId } from '../tenancy/run-id'
import { fakeEnv } from '../testing/fake-env'
import { authorizeLoomsRoute, authorizeRun, runIdOfPath } from './gate'

const ORG_A = 'orgA0000000000000000000000000000'
const ORG_B = 'orgB0000000000000000000000000000'

function actor(userId: string, orgId = ORG_A, role: Actor['role'] = 'member'): Actor {
  return { userId, orgId, role, name: userId, email: `${userId}@example.com` }
}

/** An env whose session objects answer `getAccess` from `records`, and count the lookups. */
function envWith(records: Record<string, SessionAccess>) {
  const asked: string[] = []

  const env = fakeEnv({
    LOOMS_RUN: {
      getByName: (runId: string) =>
        // SAFETY: the gate only calls `getAccess` on the stub, which this fake answers.
        ({
          getAccess: async () => {
            asked.push(runId)
            return records[runId] ?? null
          },
        }) as never,
    },
  })

  return { env, asked }
}

describe('authorizeRun', () => {
  const session = scopedRunId(ORG_A, 'session_1')

  test('a run in another organization is not found, and its object is never touched', async () => {
    const { env, asked } = envWith({
      [session]: { ownerId: 'alice', memberIds: [], visibility: 'private' },
    })

    const denied = await authorizeRun(env, actor('mallory', ORG_B, 'owner'), session)

    expect(denied?.status).toBe(404)
    expect(asked).toEqual([])
  })

  test('a run with no organization is never reachable', async () => {
    const { env } = envWith({})

    expect((await authorizeRun(env, actor('alice'), 'session_1'))?.status).toBe(404)
    expect((await authorizeRun(env, actor('alice'), 'shuttle-workspace'))?.status).toBe(404)
  })

  test('a session opens for its owner and the people it is shared with only', async () => {
    const { env } = envWith({
      [session]: { ownerId: 'alice', memberIds: ['bob'], visibility: 'private' },
    })

    expect(await authorizeRun(env, actor('alice'), session)).toBeNull()
    expect(await authorizeRun(env, actor('bob'), session)).toBeNull()
    expect((await authorizeRun(env, actor('carol'), session))?.status).toBe(404)
    // An organization admin gets no exception.
    expect((await authorizeRun(env, actor('carol', ORG_A, 'owner'), session))?.status).toBe(404)
  })

  test('a public session opens for everyone in its organization and no one outside it', async () => {
    const { env } = envWith({
      [session]: { ownerId: 'alice', memberIds: [], visibility: 'public' },
    })

    expect(await authorizeRun(env, actor('carol'), session)).toBeNull()
    expect((await authorizeRun(env, actor('carol', ORG_B), session))?.status).toBe(404)
  })

  test("a person's own workspace opens for that person only", async () => {
    const { env } = envWith({})
    const alices = personalRunId(ORG_A, 'alice', 'shuttle-workspace')

    expect(await authorizeRun(env, actor('alice'), alices)).toBeNull()
    expect((await authorizeRun(env, actor('bob'), alices))?.status).toBe(404)
    expect((await authorizeRun(env, actor('bob', ORG_A, 'owner'), alices))?.status).toBe(404)
    expect((await authorizeRun(env, actor('alice', ORG_B), alices))?.status).toBe(404)
  })

  test('a reflection run follows the access of its session', async () => {
    const { env, asked } = envWith({
      [session]: { ownerId: 'alice', memberIds: [], visibility: 'private' },
    })

    expect((await authorizeRun(env, actor('bob'), reflectionRunId(session)))?.status).toBe(404)
    expect(await authorizeRun(env, actor('alice'), reflectionRunId(session))).toBeNull()
    expect(asked).toEqual([session, session])
  })

  test("an organization's workspace, pulls and playbook runs open for every member", async () => {
    const { env, asked } = envWith({})

    for (const local of ['shuttle-workspace', 'shuttle-pulls', 'shuttle-playbook']) {
      expect(await authorizeRun(env, actor('bob'), scopedRunId(ORG_A, local))).toBeNull()

      expect(
        (await authorizeRun(env, actor('bob', ORG_B), scopedRunId(ORG_A, local)))?.status,
      ).toBe(404)
    }

    expect(asked).toEqual([])
  })
})

describe('authorizeLoomsRoute', () => {
  const env = fakeEnv()
  const session = scopedRunId(ORG_A, 'session_1')
  const workspace = scopedRunId(ORG_A, 'shuttle-workspace')

  /** What the gate decides for a request, described the way Looms describes it. */
  function check(method: string, path: string) {
    const route = describeRoute(method, path)

    return route ? authorizeLoomsRoute(env, actor('alice'), route) : null
  }

  const allowedAsAlice: AuthDecision = { allowed: true, actorId: 'alice' }
  const denied = { allowed: false, status: 403 }

  test('a read is allowed and recorded as the reader', () => {
    expect(check('GET', `/runs/${session}/events`)).toEqual(allowedAsAlice)
    expect(check('GET', `/runs/${workspace}/projections/workspaceTree`)).toEqual(allowedAsAlice)
  })

  test('a listed signal is allowed and recorded as its sender', () => {
    expect(check('POST', `/runs/${session}/signals/shuttle/reroute`)).toEqual(allowedAsAlice)
    expect(check('POST', `/runs/${session}/signals/approval/decision`)).toEqual(allowedAsAlice)
    expect(check('POST', `/runs/${workspace}/signals/workspace/openTab`)).toEqual(allowedAsAlice)
  })

  test('a browser may send only the listed signals', () => {
    // These decide who can see what, so only Worker routes may send them.
    expect(check('POST', `/runs/${workspace}/signals/workspace/requestSession`)).toMatchObject(
      denied,
    )

    expect(check('POST', `/runs/${workspace}/signals/workspace/connectGithub`)).toMatchObject(
      denied,
    )

    expect(check('POST', `/runs/${workspace}/signals/workspace/shareSession`)).toMatchObject(denied)

    // Renaming and archiving go through the Worker, which updates every listing.
    expect(check('POST', `/runs/${workspace}/signals/workspace/renameSession`)).toMatchObject(
      denied,
    )

    expect(check('POST', `/runs/${workspace}/signals/workspace/listSession`)).toMatchObject(denied)
    // A message goes through the Worker's say route, which records its author.
    expect(check('POST', `/runs/${session}/signals/shuttle/say`)).toMatchObject(denied)
    // A workspace signal is not a session signal.
    expect(check('POST', `/runs/${session}/signals/workspace/openTab`)).toMatchObject(denied)
  })

  test("a person's own workspace takes tab signals and nothing else", () => {
    const personal = personalRunId(ORG_A, 'alice', 'shuttle-workspace')

    expect(check('POST', `/runs/${personal}/signals/workspace/openTab`)).toEqual(allowedAsAlice)
    expect(check('GET', `/runs/${personal}/events`)).toEqual(allowedAsAlice)
    // Folders belong to the organization.
    expect(check('POST', `/runs/${personal}/signals/workspace/createFolder`)).toMatchObject(denied)

    expect(check('POST', `/runs/${personal}/signals/workspace/requestSession`)).toMatchObject(
      denied,
    )
  })

  test('raw events, starts, cancels and operator routes are refused', () => {
    expect(check('POST', `/runs/${session}/events`)).toMatchObject(denied)
    expect(check('POST', `/runs/${session}/cancel`)).toMatchObject(denied)
    expect(check('POST', `/runs/${session}/wake`)).toMatchObject(denied)
    expect(check('POST', '/runs')).toMatchObject(denied)
    expect(check('POST', '/runs/launch')).toMatchObject(denied)
    expect(check('POST', '/operations/deadlines/rescan')).toMatchObject(denied)
  })
})

describe('runIdOfPath', () => {
  test('finds the run a path is about', () => {
    expect(runIdOfPath('/runs/abc/events')).toBe('abc')
    expect(runIdOfPath('/sessions/o-x-session_1/sandbox/files')).toBe('o-x-session_1')
    expect(runIdOfPath('/sessions')).toBeNull()
    expect(runIdOfPath('/workspace/sessions')).toBeNull()
    expect(runIdOfPath('/runs/%E0%A4%A/x')).toBeNull()
  })
})

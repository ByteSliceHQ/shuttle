import { describe, expect, test } from 'bun:test'

import { z } from 'zod'

import type { EngineEnv } from '../env'
import type { ShuttleHost } from '../ports/host'
import type { IdentityPort } from '../ports/identity'
import type { SessionAccess } from '../tenancy/access'
import { fakeEnv } from '../testing/fake-env'
import { firehoseApi, serveShuttle, sessionApi, type ApiModule, type ServeOptions } from './serve'

const RUN = 'o-org1-session_1'
const SECRET = 'a-grant-secret-of-at-least-32-characters'

const Body = z.record(z.string(), z.json())

/** Whoever the `x-test-user` header names, in org1; nobody without it. */
const byHeader: IdentityPort = {
  resolve: async (request) => {
    const userId = request.headers.get('x-test-user')

    return userId === null
      ? null
      : {
          kind: 'person',
          actor: { userId, orgId: 'org1', role: 'member', name: userId, email: '' },
        }
  },
}

/** A host whose runs answer `getAccess` and `getHarness`, and nothing else. */
function hostWith(access: SessionAccess | null = null): ShuttleHost {
  const stub = {
    getAccess: async () => access,
    getHarness: async () => ({ harness: 'shuttle' }),
  }

  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: the namespace answers getByName, the only method these routes call on it, and the stub answers the two calls they make to a run.
  const LOOMS_RUN = { getByName: () => stub } as unknown as EngineEnv['LOOMS_RUN']

  return { env: fakeEnv({ LOOMS_RUN }), ports: { identity: byHeader } }
}

async function ask(
  path: string,
  init: RequestInit = {},
  options: Partial<ServeOptions> = {},
  host: ShuttleHost = hostWith(),
) {
  const serve = serveShuttle(host, { modules: [sessionApi, firehoseApi], ...options })

  return serve(new Request(`http://host.test${path}`, init))
}

const asAda = { headers: { 'x-test-user': 'ada' } }

/** Stands in for the module that serves a run's log, which loads only in a Worker. */
const runs: ApiModule = {
  name: 'runs',
  claims: (pathname) => pathname.startsWith('/runs/'),
  handle: async () => null,
}

describe('serveShuttle', () => {
  test('leaves a path that is not Shuttle’s to the host', async () => {
    expect(await ask('/billing', asAda)).toBeNull()
    expect(await ask('/', asAda)).toBeNull()
  })

  test('leaves a path of a module the host did not mount to the host', async () => {
    expect(await ask('/firehose/events', asAda, { modules: [sessionApi] })).toBeNull()
  })

  test('says which modules are mounted, to anyone', async () => {
    const response = await ask('/capabilities', {}, { modules: [sessionApi] })

    expect(Body.parse(await response?.json())).toEqual({
      modules: ['session'],
      previews: false,
      grants: false,
    })
  })

  test('refuses a request from nobody the identity port knows', async () => {
    expect((await ask(`/sessions/${RUN}/harness`))?.status).toBe(401)
  })

  test('answers a route of the contract for someone who may open the session', async () => {
    const response = await ask(`/sessions/${RUN}/harness`, asAda)

    expect(response?.status).toBe(200)
    expect(Body.parse(await response?.json())).toEqual({ harness: 'shuttle' })
  })

  test("hides another organization's run, and a private session from someone it is not shared with", async () => {
    expect((await ask('/sessions/o-org2-session_1/harness', asAda))?.status).toBe(404)

    const mine: SessionAccess = { ownerId: 'grace', memberIds: [], visibility: 'private' }

    expect((await ask(`/sessions/${RUN}/harness`, asAda, {}, hostWith(mine)))?.status).toBe(404)
  })

  test('answers a page on a listed origin so its browser can read it, and no other', async () => {
    const options = { origins: ['https://app.example'] }

    const listed = await ask(
      `/sessions/${RUN}/harness`,
      { headers: { 'x-test-user': 'ada', origin: 'https://app.example' } },
      options,
    )

    const other = await ask(
      `/sessions/${RUN}/harness`,
      { headers: { 'x-test-user': 'ada', origin: 'https://elsewhere.example' } },
      options,
    )

    expect(listed?.headers.get('access-control-allow-origin')).toBe('https://app.example')
    expect(other?.headers.get('access-control-allow-origin')).toBeNull()

    const preflight = await ask(
      `/sessions/${RUN}/harness`,
      { method: 'OPTIONS', headers: { origin: 'https://app.example' } },
      options,
    )

    expect(preflight?.status).toBe(204)
    expect(preflight?.headers.get('access-control-allow-headers')).toContain('authorization')
  })

  test('gives a read grant for a run to someone who may open it, when the host signs them', async () => {
    const options = { grantSecret: SECRET, modules: [sessionApi, runs] }
    const granted = await ask(`/runs/${RUN}/grant`, { method: 'POST', ...asAda }, options)

    expect(granted?.status).toBe(200)

    const body = z.object({ grant: z.string(), expiresAt: z.number() }).parse(await granted?.json())

    expect(body.grant.startsWith('v1.')).toBe(true)
    expect(body.expiresAt).toBeGreaterThan(Date.now())

    // Not for a run they may not open.
    const elsewhere = await ask(
      '/runs/o-org2-session_1/grant',
      { method: 'POST', ...asAda },
      options,
    )

    expect(elsewhere?.status).toBe(404)
  })
})

import { describe, expect, test } from 'bun:test'

import type { EventInput } from '@swirls/looms/core'

import type { EngineEnv } from '../env'
import type { ActingFor } from '../ports/identity'
import type { SessionStartRequest } from '../ports/session-start'
import type { SessionAccess } from '../tenancy/access'
import { fakeEnv } from '../testing/fake-env'
import { NO_FOLDER } from '../workspace/scope'
import { HeadlessRequestError, startHeadlessSession, type HeadlessSessionRequest } from './start'

/** What a call rejects with; fails the test when the call succeeds. */
async function rejection(call: Promise<unknown>): Promise<Error> {
  try {
    await call
  } catch (error) {
    if (error instanceof Error) {
      return error
    }

    throw error
  }

  throw new Error('expected the call to fail')
}

interface Recorded {
  readonly run: string
  readonly signals: EventInput[]
  access: SessionAccess | null
}

/** A Looms namespace that remembers what each run was told. */
function recordingNamespace() {
  const runs = new Map<string, Recorded>()

  const record = (name: string): Recorded => {
    const found = runs.get(name) ?? { run: name, signals: [], access: null }

    runs.set(name, found)

    return found
  }

  const stubFor = (name: string) => {
    const recorded = record(name)

    return {
      getRun: async () => ({ startIdentity: { kind: 'x' } }),
      launch: async () => {},
      setAccess: async (access: SessionAccess) => {
        recorded.access = access
        return access
      },
      signal: async (events: readonly EventInput[]) => {
        recorded.signals.push(...events)
        return {}
      },
    }
  }

  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: the namespace answers getByName, the only method a start calls on it, and each stub answers the calls a start makes to a run.
  const namespace = { getByName: stubFor } as unknown as EngineEnv['LOOMS_RUN']

  return { namespace, runs }
}

const repo = {
  installationId: 42,
  fullName: 'ByteSliceHQ/glue',
  defaultBranch: 'main',
  private: true,
}

const person: ActingFor = {
  kind: 'person',
  actor: { userId: 'u1', orgId: 'org1', role: 'member', name: 'Ada', email: '' },
}

const organization: ActingFor = { kind: 'organization', orgId: 'org1', service: 'build-host' }

function request(overrides: Partial<HeadlessSessionRequest> = {}): HeadlessSessionRequest {
  return { acting: organization, brief: 'Fix the flaky test', repositories: [repo], ...overrides }
}

describe('startHeadlessSession', () => {
  test('requests a session with no folder, carrying the host metadata', async () => {
    const { namespace, runs } = recordingNamespace()
    const env = fakeEnv({ LOOMS_RUN: namespace })

    const { runId } = await startHeadlessSession(
      { env },
      request({ metadata: { workItem: 'WI-7' }, idempotencyKey: 'wi-7' }),
    )

    expect(runId).toBe('o-org1-session_wi-7')

    const requested = [...runs.values()]
      .flatMap((run) => run.signals)
      .find((event) => event.type === 'workspace.session.requested')

    expect(requested?.payload).toMatchObject({
      runId,
      folderId: NO_FOLDER,
      goal: 'Fix the flaky test',
      hostMetadata: { workItem: 'WI-7' },
      repos: [{ owner: 'ByteSliceHQ', name: 'glue', installationId: 42 }],
    })
  })

  test("an organization's session is open to it; a person's is private to them", async () => {
    const { namespace, runs } = recordingNamespace()
    const env = fakeEnv({ LOOMS_RUN: namespace })

    const shared = await startHeadlessSession({ env }, request())
    const own = await startHeadlessSession({ env }, request({ acting: person }))

    expect(runs.get(shared.runId)?.access).toEqual({
      ownerId: null,
      memberIds: [],
      visibility: 'public',
    })

    expect(runs.get(own.runId)?.access).toEqual({
      ownerId: 'u1',
      memberIds: [],
      visibility: 'private',
    })
  })

  test('a refusal from the host creates nothing', async () => {
    const { namespace, runs } = recordingNamespace()
    const env = fakeEnv({ LOOMS_RUN: namespace })

    const error = await rejection(
      startHeadlessSession(
        {
          env,
          ports: {
            sessionStart: { admit: async () => ({ allowed: false, reason: 'plan limit' }) },
          },
        },
        request(),
      ),
    )

    expect(error).toMatchObject({ reason: 'plan limit' })
    expect(runs.size).toBe(0)
  })

  test('the host is asked first, with the metadata it gave', async () => {
    const { namespace } = recordingNamespace()
    const asked: SessionStartRequest[] = []

    await startHeadlessSession(
      {
        env: fakeEnv({ LOOMS_RUN: namespace }),
        ports: {
          sessionStart: {
            admit: async (start) => {
              asked.push(start)
              return { allowed: true }
            },
          },
        },
      },
      request({ metadata: { threadId: 't1' } }),
    )

    expect(asked).toEqual([
      {
        kind: 'host',
        orgId: 'org1',
        acting: organization,
        repos: ['ByteSliceHQ/glue'],
        metadata: { threadId: 't1' },
      },
    ])
  })

  test('rejects a request that cannot be a session', async () => {
    const { namespace } = recordingNamespace()
    const host = { env: fakeEnv({ LOOMS_RUN: namespace }) }

    for (const bad of [
      request({ brief: '   ' }),
      request({ repositories: [] }),
      request({ repositories: [{ ...repo, fullName: 'no-slash' }] }),
      request({ idempotencyKey: 'has space' }),
      request({ metadata: { key: 'x'.repeat(3000) } }),
    ]) {
      expect(await rejection(startHeadlessSession(host, bad))).toBeInstanceOf(HeadlessRequestError)
    }
  })
})

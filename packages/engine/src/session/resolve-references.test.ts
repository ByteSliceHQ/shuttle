import { describe, expect, test } from 'bun:test'

import { scopedRunId } from '@shuttle/api'

import { personalWorkspaceRunId, workspaceRunId } from '../config'
import { readDigestSource } from '../session/digest-source'
import type { SessionAccess } from '../tenancy/access'
import { fakeEnv } from '../testing/fake-env'
import { resolveReferences, sessionDigest } from './resolve-references'

const ORG = 'orgA0000000000000000000000000000'
const here = scopedRunId(ORG, 'session_here')
const login = scopedRunId(ORG, 'session_login')
const calc = scopedRunId(ORG, 'session_calc')

const actor = { userId: 'alice', orgId: ORG, role: 'member' as const, name: 'Alice', email: 'a@x' }

/** A run namespace where workspaces list both sessions and each session answers for itself. */
function envFor(access: Record<string, SessionAccess | null>) {
  const listingReads: string[] = []
  const digestReads: string[] = []

  const env = fakeEnv({
    // SAFETY: `resolveReferences` only calls `fetch` on workspaces and `getAccess` and
    // `getDigestSource` on sessions.
    LOOMS_RUN: {
      getByName: (runId: string) =>
        ({
          fetch: async () => {
            listingReads.push(runId)

            return Response.json({
              value: {
                sessions: {
                  [login]: {
                    folderId: 'f',
                    title: 'Fix login',
                    goal: 'fix login',
                    status: 'running',
                  },
                  [calc]: { folderId: 'f', title: 'Calculator', goal: 'calc', status: 'completed' },
                },
              },
            })
          },
          getAccess: async () => access[runId] ?? null,
          getDigestSource: async () => {
            digestReads.push(runId)

            return { brief: 'fix login', replies: [`done in ${runId}`] }
          },
        }) as never,
    },
  })

  return { env, listingReads, digestReads }
}

describe('resolveReferences', () => {
  test('reads each workspace once for the whole message and each session once', async () => {
    const { env, listingReads, digestReads } = envFor({})

    const resolved = await resolveReferences(env, actor, here, '@Fix login and @Calculator', [
      { kind: 'session', sessionId: login, label: 'Fix login' },
      { kind: 'session', sessionId: calc },
      { kind: 'session', sessionId: login },
      { kind: 'session', sessionId: here },
      { kind: 'file', path: 'web/a.ts' },
    ])

    // Each workspace once, however many sessions the message names.
    expect(listingReads.toSorted()).toEqual(
      [personalWorkspaceRunId(env, ORG, actor.userId), workspaceRunId(env, ORG)].toSorted(),
    )

    expect(digestReads.toSorted()).toEqual([calc, login].toSorted())

    expect(resolved).toEqual([
      {
        kind: 'session',
        sessionId: login,
        title: 'Fix login',
        label: 'Fix login',
        digest: `Goal: fix login\nStatus: running\nLatest from its agents:\ndone in ${login}`,
      },
      {
        kind: 'session',
        sessionId: calc,
        title: 'Calculator',
        digest: `Goal: calc\nStatus: completed\nBrief:\nfix login\nLatest from its agents:\ndone in ${calc}`,
      },
      { kind: 'file', path: 'web/a.ts' },
    ])
  })

  test('refuses a session the sender cannot open, or one in another organization', async () => {
    const { env } = envFor({ [calc]: { ownerId: 'bob', memberIds: [], visibility: 'private' } })

    const notOpen = await resolveReferences(env, actor, here, '@Calculator', [
      { kind: 'session', sessionId: calc },
    ]).catch((cause: unknown) => cause)

    expect(String(notOpen)).toContain('cannot open')

    const elsewhere = scopedRunId('orgB0000000000000000000000000000', 'session_x')

    const otherOrg = await resolveReferences(env, actor, here, '@x', [
      { kind: 'session', sessionId: elsewhere },
    ]).catch((cause: unknown) => cause)

    expect(String(otherOrg)).toContain('cannot open')
  })

  test('refuses a run no workspace lists, such as a workspace or an id that names nothing', async () => {
    const { env, digestReads } = envFor({})
    const workspace = scopedRunId(ORG, 'shuttle-workspace')

    const refused = await resolveReferences(env, actor, here, '@x', [
      { kind: 'session', sessionId: workspace },
    ]).catch((cause: unknown) => cause)

    expect(String(refused)).toContain('cannot open')
    expect(digestReads).toEqual([])
  })
})

describe('readDigestSource', () => {
  test('keeps the brief and the latest agent messages that say something', async () => {
    const source = await readDigestSource(async (name) =>
      Response.json(
        name === 'brief'
          ? { value: { text: 'the brief' } }
          : {
              value: {
                messages: [
                  { role: 'assistant', text: 'first' },
                  { role: 'user', text: 'a question' },
                  { role: 'assistant', text: 'second' },
                  { role: 'assistant', text: 'third' },
                  { role: 'assistant', text: '  ' },
                ],
              },
            },
      ),
    )

    expect(source).toEqual({ brief: 'the brief', replies: ['second', 'third'] })
  })

  test('reads nothing from projections it cannot parse', async () => {
    expect(await readDigestSource(async () => Response.json(null))).toEqual({
      brief: '',
      replies: [],
    })
  })
})

describe('sessionDigest', () => {
  test('leaves out a brief that only repeats the goal, and clips long replies', () => {
    const digest = sessionDigest({
      goal: 'Fix login',
      status: 'completed',
      brief: 'Fix login',
      replies: ['', 'x'.repeat(1_300)],
    })

    expect(digest).toBe(
      `Goal: Fix login\nStatus: completed\nLatest from its agents:\n${'x'.repeat(1_200)}…`,
    )
  })
})

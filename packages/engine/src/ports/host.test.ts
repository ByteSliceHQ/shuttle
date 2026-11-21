import { describe, expect, test } from 'bun:test'

import { fixedGitAccess } from '@shuttle/git/access'

import { fakeEnv } from '../testing/fake-env'
import { neverExpire } from './approvals'
import { sponsorCredentials } from './credentials'
import { resolveHost } from './host'
import { noIdentity } from './identity'
import { openSessionStart } from './session-start'

describe('a host that replaces nothing', () => {
  test('gets what a standalone Shuttle does for every port', async () => {
    const env = fakeEnv()
    const { env: resolved, ports } = resolveHost({ env })

    expect(resolved).toBe(env)

    expect(ports).toEqual({
      identity: noIdentity,
      sessionStart: openSessionStart,
      credentials: sponsorCredentials,
      approvals: neverExpire,
      git: null,
    })

    expect(
      await ports.sessionStart.admit({ kind: 'person', orgId: 'org1', acting: null, repos: [] }),
    ).toEqual({ allowed: true })

    expect(
      ports.approvals.expiresAfterMs({
        kind: 'publish-pull-request',
        approvalId: 'pr_publish_1',
        orgId: 'org1',
      }),
    ).toBeNull()

    expect(
      ports.credentials.ownerOf({
        runId: 'o-org1-session_1',
        orgId: 'org1',
        harness: 'codex',
        sponsorId: 'ada',
      }),
    ).toEqual({ kind: 'person', userId: 'ada' })

    expect(await ports.identity.resolve(new Request('https://shuttle.test/'))).toBeNull()
  })
})

describe('a host that replaces a port', () => {
  test('keeps the standalone behaviour of the others', () => {
    const approvals = { expiresAfterMs: () => 60_000 }
    const { ports } = resolveHost({ env: fakeEnv(), ports: { approvals } })

    expect(ports.approvals).toBe(approvals)
    expect(ports.sessionStart).toBe(openSessionStart)
    expect(ports.credentials).toBe(sponsorCredentials)
  })

  test('its Git access is what the engine reads from the environment', () => {
    const git = fixedGitAccess('token')
    const { env, ports } = resolveHost({ env: fakeEnv(), ports: { git } })

    expect(ports.git).toBe(git)
    expect(env.GIT_ACCESS).toBe(git)
  })
})

import { describe, expect, test } from 'bun:test'

import type { CredentialPayload } from '../credentials/store'
import {
  sponsorCredentials,
  turnCredentials,
  type CredentialPort,
  type SignInStore,
  type TurnCredentialRequest,
} from './credentials'

function signIns(initial: Record<string, CredentialPayload> = {}) {
  const kept = new Map(Object.entries(initial))

  const store: SignInStore = {
    getCredential: async (userId, harness) => kept.get(`${userId}:${harness}`) ?? null,
    putCredential: async (userId, harness, payload) => {
      kept.set(`${userId}:${harness}`, payload)
    },
  }

  return { store, kept }
}

function turn(sponsorId: string | null): TurnCredentialRequest {
  return { runId: 'o-org1-session_1', orgId: 'org1', harness: 'claude-code', sponsorId }
}

const signIn: CredentialPayload = { files: { '.claude/.credentials.json': 'c2lnbi1pbg==' } }

describe('standalone credentials', () => {
  test('a turn runs on the sign-in of the person it is working for', async () => {
    const { store } = signIns({ 'ada:claude-code': signIn })
    const credentials = turnCredentials(sponsorCredentials, store, turn('ada'))

    expect(credentials.owner).toEqual({ kind: 'person', userId: 'ada' })
    expect(await credentials.get('claude-code')).toEqual(signIn)
  })

  test('a turn nobody asked for runs on nobody', async () => {
    const { store, kept } = signIns({ 'ada:claude-code': signIn })
    const credentials = turnCredentials(sponsorCredentials, store, turn(null))

    expect(credentials.owner).toBeNull()
    expect(await credentials.get('claude-code')).toBeNull()

    await credentials.put('claude-code', { files: { a: 'b' } })

    expect(kept.get('ada:claude-code')).toEqual(signIn)
  })

  test('a refreshed sign-in is kept for the person it belongs to', async () => {
    const { store, kept } = signIns({ 'ada:claude-code': signIn })
    const credentials = turnCredentials(sponsorCredentials, store, turn('ada'))
    const refreshed = { files: { '.claude/.credentials.json': 'bmV3' } }

    await credentials.get('claude-code')
    await credentials.put('claude-code', refreshed)

    expect(kept.get('ada:claude-code')).toEqual(refreshed)
  })
})

describe('a host credential port', () => {
  test("cannot run a turn on another person's sign-in", async () => {
    const { store } = signIns({ 'grace:claude-code': signIn })

    const port: CredentialPort = { ownerOf: () => ({ kind: 'person', userId: 'grace' }) }

    const forAda = turnCredentials(port, store, turn('ada'))
    const forNobody = turnCredentials(port, store, turn(null))

    expect(forAda.owner).toBeNull()
    expect(await forAda.get('claude-code')).toBeNull()
    expect(forNobody.owner).toBeNull()
  })

  test("runs an unattended turn on the organization's API key", async () => {
    const { store, kept } = signIns()

    const port: CredentialPort = {
      ownerOf: ({ sponsorId, orgId }) =>
        sponsorId === null && orgId !== null
          ? { kind: 'organization', orgId }
          : sponsorCredentials.ownerOf({ runId: '', orgId, harness: 'claude-code', sponsorId }),
      apiKeys: async ({ owner }) =>
        owner.kind === 'organization' ? { ANTHROPIC_API_KEY: 'sk-test' } : null,
    }

    const credentials = turnCredentials(port, store, turn(null))

    expect(credentials.owner).toEqual({ kind: 'organization', orgId: 'org1' })
    expect(await credentials.get('claude-code')).toEqual({ env: { ANTHROPIC_API_KEY: 'sk-test' } })

    await credentials.put('claude-code', {
      env: { ANTHROPIC_API_KEY: 'sk-test' },
      files: { a: 'b' },
    })

    expect(kept.size).toBe(0)
  })

  test('an organization with no key has no credential, and never a sign-in', async () => {
    const { store } = signIns({ 'org1:claude-code': signIn, 'org_org1:claude-code': signIn })

    const port: CredentialPort = { ownerOf: () => ({ kind: 'organization', orgId: 'org1' }) }

    expect(await turnCredentials(port, store, turn('ada')).get('claude-code')).toBeNull()
  })

  test("a person's own API key comes before their sign-in, which stays where it is", async () => {
    const { store, kept } = signIns({ 'ada:claude-code': signIn })

    const port: CredentialPort = {
      ...sponsorCredentials,
      apiKeys: async () => ({ ANTHROPIC_API_KEY: 'sk-ada' }),
    }

    const credentials = turnCredentials(port, store, turn('ada'))

    expect(await credentials.get('claude-code')).toEqual({ env: { ANTHROPIC_API_KEY: 'sk-ada' } })

    await credentials.put('claude-code', { env: { ANTHROPIC_API_KEY: 'sk-ada' } })

    expect(kept.get('ada:claude-code')).toEqual(signIn)
  })
})

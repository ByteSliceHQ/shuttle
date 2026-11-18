import { describe, expect, test } from 'bun:test'

import { agentRole, withVendorAgents, type AgentIdentity } from './agents'

function identity(threadId: string, definitionName: string): AgentIdentity {
  const role = agentRole(definitionName)

  return { threadId, definitionName, label: role.label, role }
}

const identities = new Map([
  ['session', identity('session', 'coding')],
  ['conductor', identity('conductor', 'conductor')],
  ['intake', identity('intake', 'intake')],
])

function labels(result: ReadonlyMap<string, AgentIdentity>): Record<string, string> {
  return Object.fromEntries([...result].map(([threadId, entry]) => [threadId, entry.label]))
}

const whose = (userId: string) => (userId === 'me' ? 'your' : "Alice's")

const blurb = (billedTo?: string) =>
  withVendorAgents(
    identities,
    { conductor: { label: 'Claude Code', billedTo } },
    'claude-code',
    whose,
  ).get('conductor')?.role.blurb

describe('withVendorAgents', () => {
  test('names the working thread after the session agent before its first step', () => {
    expect(labels(withVendorAgents(identities, {}, 'claude-code'))).toEqual({
      session: 'Session',
      conductor: 'Claude Code',
      intake: 'Intake',
    })
  })

  test('leaves a Shuttle session alone', () => {
    expect(withVendorAgents(identities, {}, 'shuttle')).toBe(identities)
    expect(labels(withVendorAgents(identities, {}))).toMatchObject({ conductor: 'Conductor' })
  })

  test('what actually ran a thread wins over what the session is set to', () => {
    const result = withVendorAgents(
      identities,
      { conductor: { label: 'Codex', model: 'gpt-test' } },
      'claude-code',
    )

    expect(result.get('conductor')?.label).toBe('Codex')
    expect(result.get('conductor')?.role.blurb).toContain('gpt-test')
  })

  test('says whose subscription a turn ran on', () => {
    expect(blurb('me')).toBe('Claude Code on your subscription.')
    expect(blurb('alice')).toBe("Claude Code on Alice's subscription.")
    // A turn from before sign-ins were recorded per person.
    expect(blurb()).toBe('Claude Code on your subscription.')
  })
})

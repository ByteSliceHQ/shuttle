import { describe, expect, test } from 'bun:test'

import {
  localRunName,
  orgOfRun,
  parsePersonalRunId,
  parseRunId,
  personalRunId,
  reflectionRunId,
  scopedRunId,
  sessionOfReflection,
  siblingRunId,
} from './run-id'

const ORG = 'AQz2U7YhUr93mdvwWRF0xxKRNthpC0Gb'

describe('run ids', () => {
  test('a scoped id round-trips its organization and local name', () => {
    const runId = scopedRunId(ORG, 'session_1f0e-22')

    expect(runId).toBe(`o-${ORG}-session_1f0e-22`)
    expect(parseRunId(runId)).toEqual({ orgId: ORG, local: 'session_1f0e-22' })
    expect(orgOfRun(runId)).toBe(ORG)
  })

  test('an id without the prefix belongs to no organization', () => {
    expect(parseRunId('shuttle-workspace')).toEqual({ orgId: null, local: 'shuttle-workspace' })
    expect(scopedRunId(null, 'shuttle-workspace')).toBe('shuttle-workspace')
    // Looks close, but an organization id has no punctuation.
    expect(orgOfRun('o-not_an_org-session')).toBeNull()
  })

  test('an organization id that could forge another prefix is refused', () => {
    expect(() => scopedRunId('abc-def', 'x')).toThrow('invalid organization id')
    expect(() => scopedRunId('', 'x')).toThrow('invalid organization id')
  })

  test('a derived run stays in the same organization', () => {
    const session = scopedRunId(ORG, 'session_abc')

    expect(siblingRunId(session, (local) => `${local}-copy`)).toBe(`o-${ORG}-session_abc-copy`)
    expect(reflectionRunId(session)).toBe(`o-${ORG}-reflect_session_abc`)
    expect(sessionOfReflection(reflectionRunId(session))).toBe(session)
    expect(sessionOfReflection(session)).toBe(session)
    expect(sessionOfReflection('reflect_session_abc')).toBe('session_abc')
  })
})

describe('personal run ids', () => {
  test('a personal run names its organization, its person and what it is', () => {
    const runId = personalRunId(ORG, 'user123', 'shuttle-workspace')

    expect(runId).toBe(`o-${ORG}-member-user123-shuttle-workspace`)

    expect(parsePersonalRunId(runId)).toEqual({
      orgId: ORG,
      userId: 'user123',
      local: 'shuttle-workspace',
    })

    expect(localRunName(runId)).toBe('shuttle-workspace')
    expect(orgOfRun(runId)).toBe(ORG)
  })

  test('other runs are not personal', () => {
    expect(parsePersonalRunId(scopedRunId(ORG, 'shuttle-workspace'))).toBeNull()
    expect(parsePersonalRunId(scopedRunId(ORG, 'session_abc'))).toBeNull()
    // Without an organization there is no one it could belong to.
    expect(parsePersonalRunId('member-user123-shuttle-workspace')).toBeNull()
    expect(localRunName(scopedRunId(ORG, 'session_abc'))).toBe('session_abc')
  })

  test('a user id that could forge another prefix is refused', () => {
    expect(() => personalRunId(ORG, 'a-b', 'x')).toThrow('invalid user id')
  })
})

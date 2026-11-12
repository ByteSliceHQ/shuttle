import { describe, expect, test } from 'bun:test'

import { assertNeverRunKind, runKindFor, type RunKind } from './run-kind'

describe('runKindFor', () => {
  const env = {
    SHUTTLE_WORKSPACE_RUN_ID: 'shuttle-workspace',
    SHUTTLE_PLAYBOOK_RUN_ID: 'shuttle-playbook',
    SHUTTLE_PULLS_RUN_ID: 'shuttle-pulls',
  }

  test('classifies singleton runs and sessions', () => {
    expect(runKindFor(env, 'shuttle-workspace')).toBe('workspace')
    expect(runKindFor(env, 'shuttle-playbook')).toBe('playbook')
    expect(runKindFor(env, 'shuttle-pulls')).toBe('pulls')
    expect(runKindFor(env, 'session_abc')).toBe('session')
  })

  test('uses default ids when env vars are unset', () => {
    expect(runKindFor({}, 'shuttle-workspace')).toBe('workspace')
    expect(runKindFor({}, 'shuttle-playbook')).toBe('playbook')
    expect(runKindFor({}, 'shuttle-pulls')).toBe('pulls')
  })
})

describe('assertNeverRunKind', () => {
  test('is reachable only for exhaustive default branches', () => {
    const kind = 'session' as RunKind

    switch (kind) {
      case 'session':
      case 'workspace':
      case 'playbook':
      case 'pulls':
        expect(kind).toBe('session')
        break

      default: {
        const exhaustive: never = kind
        assertNeverRunKind(exhaustive)
      }
    }
  })
})

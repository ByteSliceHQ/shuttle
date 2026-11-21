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

function nameOf(kind: RunKind): string {
  switch (kind) {
    case 'session':
    case 'workspace':
    case 'playbook':
    case 'pulls':
      return kind

    default: {
      const exhaustive: never = kind

      return assertNeverRunKind(exhaustive)
    }
  }
}

describe('assertNeverRunKind', () => {
  test('is reachable only for exhaustive default branches', () => {
    expect(nameOf('session')).toBe('session')
  })
})

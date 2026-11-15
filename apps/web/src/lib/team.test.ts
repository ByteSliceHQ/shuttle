import { describe, expect, test } from 'bun:test'

import type { Connection, Team } from './api'
import { effectiveTeam } from './team'

function team(overrides: Partial<Team> = {}): Team {
  return {
    workers: true,
    codex: false,
    claudeCode: false,
    cursor: false,
    preset: 'none',
    ...overrides,
  }
}

function connections(codex: boolean, claudeCode: boolean, cursor = false): Connection[] {
  return [
    { harness: 'codex', label: 'Codex', connected: codex, updatedAt: null },
    { harness: 'claude-code', label: 'Claude Code', connected: claudeCode, updatedAt: null },
    { harness: 'cursor', label: 'Cursor', connected: cursor, updatedAt: null },
  ]
}

describe('effectiveTeam', () => {
  test('keeps a vendor agent whose subscription is connected', () => {
    const saved = team({ codex: true, claudeCode: true, preset: 'codex-builds-claude-reviews' })

    expect(effectiveTeam(saved, connections(true, true))).toEqual(saved)
  })

  test('leaves out a vendor agent that is not connected', () => {
    expect(effectiveTeam(team({ codex: true }), connections(false, true))).toEqual(team())
  })

  test('drops a preset that names an agent that is not connected', () => {
    const saved = team({ codex: true, claudeCode: true, preset: 'claude-builds-codex-reviews' })

    expect(effectiveTeam(saved, connections(false, true))).toEqual(team({ claudeCode: true }))
  })

  test('falls back to Shuttle workers when no one else is left', () => {
    const saved = team({ workers: false, codex: true })

    expect(effectiveTeam(saved, connections(false, false))).toEqual(team())
  })

  test('keeps Cursor when its subscription is connected', () => {
    const saved = team({ cursor: true })

    expect(effectiveTeam(saved, connections(false, false, true))).toEqual(saved)
    expect(effectiveTeam(saved, connections(false, false, false))).toEqual(team())
  })
})

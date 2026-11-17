import { describe, expect, test } from 'bun:test'

import type { Connection, Team } from '@shuttle/api'

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
    {
      harness: 'codex',
      label: 'Codex',
      connected: codex,
      cloud: codex,
      local: null,
      updatedAt: null,
    },
    {
      harness: 'claude-code',
      label: 'Claude Code',
      connected: claudeCode,
      cloud: claudeCode,
      local: null,
      updatedAt: null,
    },
    {
      harness: 'cursor',
      label: 'Cursor',
      connected: cursor,
      cloud: cursor,
      local: null,
      updatedAt: null,
    },
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

  test('on this machine, leaves out an agent signed in only in the cloud', () => {
    const saved = team({ codex: true })

    const cloudOnly: Connection[] = [
      {
        harness: 'codex',
        label: 'Codex',
        connected: true,
        cloud: true,
        local: false,
        updatedAt: null,
      },
    ]

    expect(effectiveTeam(saved, cloudOnly, 'local')).toEqual(team())
    expect(effectiveTeam(saved, cloudOnly, 'cloud')).toEqual(saved)
  })
})

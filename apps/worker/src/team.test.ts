import { describe, expect, test } from 'bun:test'

import {
  DEFAULT_TEAM,
  frameTask,
  onTeam,
  parseTeam,
  presetRoles,
  readPinnedTeam,
  TEAM_STORAGE_KEY,
  writeStoredTeam,
} from './team'

function memoryStorage(initial: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(initial))

  return {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      values.set(key, value)
    },
  } as unknown as Pick<DurableObjectStorage, 'get' | 'put'>
}

describe('parseTeam', () => {
  test('reads a full team', () => {
    expect(
      parseTeam({
        workers: false,
        codex: true,
        claudeCode: true,
        preset: 'codex-builds-claude-reviews',
      }),
    ).toEqual({
      workers: false,
      codex: true,
      claudeCode: true,
      cursor: false,
      preset: 'codex-builds-claude-reviews',
    })
  })

  test('reads a team that includes Cursor', () => {
    expect(parseTeam({ workers: true, cursor: true })).toEqual({
      workers: true,
      codex: false,
      claudeCode: false,
      cursor: true,
      preset: 'none',
    })
  })

  test('always leaves someone to do the work', () => {
    expect(parseTeam({ workers: false })).toEqual(DEFAULT_TEAM)
    expect(parseTeam({ workers: false, codex: true })?.workers).toBe(false)
  })

  test('drops a preset whose agents are not both on the team', () => {
    expect(parseTeam({ codex: true, preset: 'codex-builds-claude-reviews' })?.preset).toBe('none')
    expect(parseTeam({ codex: true, claudeCode: true, preset: 'made-up' })?.preset).toBe('none')
  })

  test('rejects values that are not a team', () => {
    expect(parseTeam(null)).toBeNull()
    expect(parseTeam('codex')).toBeNull()
  })
})

describe('onTeam', () => {
  test('matches each vendor agent to its own switch', () => {
    const team = { ...DEFAULT_TEAM, codex: true }

    expect(onTeam(team, 'codex')).toBe(true)
    expect(onTeam(team, 'claude-code')).toBe(false)
    expect(onTeam(team, 'cursor')).toBe(false)
    expect(onTeam({ ...DEFAULT_TEAM, cursor: true }, 'cursor')).toBe(true)
  })
})

describe('stored team', () => {
  test('is unset until written, then round-trips', async () => {
    const storage = memoryStorage()

    expect(await readPinnedTeam(storage)).toBeNull()
    expect(await writeStoredTeam(storage, { codex: true })).toMatchObject({ codex: true })
    expect(await readPinnedTeam(storage)).toMatchObject({ workers: true, codex: true })
    expect(writeStoredTeam(storage, 'nope')).rejects.toThrow('invalid team')
  })

  test('ignores a stored value that is not a team', async () => {
    expect(await readPinnedTeam(memoryStorage({ [TEAM_STORAGE_KEY]: 7 }))).toBeNull()
  })
})

describe('presets and task framing', () => {
  test('a preset gives each agent it names a role', () => {
    expect(presetRoles('none')).toEqual({})

    const roles = presetRoles('claude-plans-codex-implements')

    expect(roles.claudeCode).toContain('plans')
    expect(roles.codex).toContain('implements')
  })

  test('review and plan tasks forbid edits; build tasks pass through', () => {
    expect(frameTask('Add a README', undefined)).toBe('Add a README')
    expect(frameTask('Add a README', 'build')).toBe('Add a README')
    expect(frameTask('Check the README', 'review')).toContain('Do not modify any files')
    expect(frameTask('Check the README', 'review')).toContain('Check the README')
    expect(frameTask('Design the README', 'plan')).toContain('implementation plan')
  })
})

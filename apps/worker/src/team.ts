import type { VendorHarnessId } from './harness'

/**
 * Who Shuttle's conductor may hand work to in a session: its own workers and any connected
 * vendor agents. This is what makes a session hybrid.
 */
export const PRESETS = [
  'none',
  'codex-builds-claude-reviews',
  'claude-builds-codex-reviews',
  'claude-plans-codex-implements',
] as const

export type PresetId = (typeof PRESETS)[number]

export interface Team {
  /** Shuttle's own workers, on OpenRouter. */
  readonly workers: boolean
  readonly codex: boolean
  readonly claudeCode: boolean
  readonly cursor: boolean
  /** Standing roles for the agents, or `none` to let the conductor decide. */
  readonly preset: PresetId
}

export const DEFAULT_TEAM: Team = {
  workers: true,
  codex: false,
  claudeCode: false,
  cursor: false,
  preset: 'none',
}
export const TEAM_STORAGE_KEY = 'shuttle:team'

/** How a task is framed for the agent that receives it. */
export type DelegateMode = 'build' | 'review' | 'plan'

function isPreset(value: unknown): value is PresetId {
  return typeof value === 'string' && (PRESETS as readonly string[]).includes(value)
}

/**
 * A valid team from untrusted input, or null. A team always has someone to do the work, and a
 * preset only stands when both agents it names are on the team.
 */
export function parseTeam(value: unknown): Team | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }

  const fields = value as Record<string, unknown>
  const codex = fields.codex === true
  const claudeCode = fields.claudeCode === true
  const cursor = fields.cursor === true
  const workers = fields.workers !== false || (!codex && !claudeCode && !cursor)
  const preset = isPreset(fields.preset) && codex && claudeCode ? fields.preset : 'none'

  return { workers, codex, claudeCode, cursor, preset }
}

export function onTeam(team: Team, harness: VendorHarnessId): boolean {
  return (
    (harness === 'codex' && team.codex) ||
    (harness === 'claude-code' && team.claudeCode) ||
    (harness === 'cursor' && team.cursor)
  )
}

type TeamStorage = Pick<DurableObjectStorage, 'get' | 'put'>

/** The team set on this run, or null when none has been chosen for it yet. */
export async function readPinnedTeam(storage: TeamStorage): Promise<Team | null> {
  return parseTeam(await storage.get(TEAM_STORAGE_KEY))
}

export async function writeStoredTeam(storage: TeamStorage, value: unknown): Promise<Team> {
  const team = parseTeam(value)

  if (!team) {
    throw new Error('invalid team')
  }

  await storage.put(TEAM_STORAGE_KEY, team)
  return team
}

/** What a preset asks of each agent. The conductor reads these on its delegate tools. */
export function presetRoles(preset: PresetId): { codex?: string; claudeCode?: string } {
  switch (preset) {
    case 'codex-builds-claude-reviews': {
      return {
        codex: 'Role this session: Codex builds. Give it the implementation work.',
        claudeCode:
          'Role this session: Claude Code reviews. After Codex changes code, send Claude Code a review (mode "review") before you report to the user.',
      }
    }

    case 'claude-builds-codex-reviews': {
      return {
        claudeCode: 'Role this session: Claude Code builds. Give it the implementation work.',
        codex:
          'Role this session: Codex reviews. After Claude Code changes code, send Codex a review (mode "review") before you report to the user.',
      }
    }

    case 'claude-plans-codex-implements': {
      return {
        claudeCode:
          'Role this session: Claude Code plans. For anything non-trivial, first ask it for an implementation plan (mode "plan").',
        codex:
          'Role this session: Codex implements. Include the plan Claude Code produced in the task you give it.',
      }
    }

    default: {
      return {}
    }
  }
}

/** Frames a task for the agent receiving it, according to its mode. */
export function frameTask(text: string, mode: DelegateMode | undefined): string {
  if (mode === 'review') {
    return [
      'Review task. Do not modify any files.',
      'Look at the current uncommitted changes in the worktree (for example with `git status` and `git diff`, or by reading the files named below) and report concrete findings: bugs, regressions, missed requirements and risky choices, each with its file and line. Say plainly if you find nothing wrong.',
      '',
      text,
    ].join('\n')
  }

  if (mode === 'plan') {
    return [
      'Planning task. Do not modify any files.',
      'Read what you need, then reply with a concrete, ordered implementation plan another engineer can follow: the files to change, what to change in each, and how to verify it.',
      '',
      text,
    ].join('\n')
  }

  return text
}

import type { Connection, Team } from './api'

/** A team always has someone to do the work, and a preset needs both agents it names. */
export function withTeamChange(team: Team, change: Partial<Team>): Team {
  const next = { ...team, ...change }
  const workers = next.workers || (!next.codex && !next.claudeCode && !next.cursor)

  return { ...next, workers, preset: next.codex && next.claudeCode ? next.preset : 'none' }
}

/**
 * The team as it will actually run: a saved team can name a vendor agent whose sign-in is gone,
 * or was never this person's, and the worker leaves that agent out.
 */
export function effectiveTeam(team: Team, connections: readonly Connection[]): Team {
  const connected = new Set(
    connections.filter((entry) => entry.connected).map((entry) => entry.harness),
  )

  return withTeamChange(team, {
    codex: team.codex && connected.has('codex'),
    claudeCode: team.claudeCode && connected.has('claude-code'),
    cursor: team.cursor && connected.has('cursor'),
  })
}

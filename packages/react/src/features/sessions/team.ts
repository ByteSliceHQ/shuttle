import type { Connection, Team } from '@shuttle/api'

import { signedInAt, type SignInPlace } from '../connections/places'

/** The team a session has before anyone chooses one: Shuttle's own workers and nobody else. */
export const DEFAULT_TEAM: Team = {
  workers: true,
  codex: false,
  claudeCode: false,
  cursor: false,
  preset: 'none',
}

/** A team always has someone to do the work, and a preset needs both agents it names. */
export function withTeamChange(team: Team, change: Partial<Team>): Team {
  const next = { ...team, ...change }
  const workers = next.workers || (!next.codex && !next.claudeCode && !next.cursor)

  return { ...next, workers, preset: next.codex && next.claudeCode ? next.preset : 'none' }
}

/**
 * Whether an agent can run where the session does. Where that place is unknown, or the agent's
 * sign-in there cannot be checked from here, being signed in anywhere is enough.
 */
export function canRunAt(connection: Connection, place?: SignInPlace | null): boolean {
  const there = place !== null && place !== undefined ? signedInAt(connection, place) : null

  return there ?? connection.connected
}

/**
 * The team as it will actually run: a saved team can name a vendor agent whose sign-in is gone,
 * or was never this person's, and the worker leaves that agent out.
 */
export function effectiveTeam(
  team: Team,
  connections: readonly Connection[],
  place?: SignInPlace | null,
): Team {
  const connected = new Set(
    connections.filter((entry) => canRunAt(entry, place)).map((entry) => entry.harness),
  )

  return withTeamChange(team, {
    codex: team.codex && connected.has('codex'),
    claudeCode: team.claudeCode && connected.has('claude-code'),
    cursor: team.cursor && connected.has('cursor'),
  })
}

import { isRecord } from '@/lib/json'

const STORAGE_KEY = 'shuttle.recent-sessions'
const LIMIT = 20

export interface RecentSession {
  readonly runId: string
  readonly goal: string
  readonly openedAt: number
}

function isRecentSession(value: unknown): value is RecentSession {
  if (!isRecord(value)) {
    return false
  }

  const entry = value
  return (
    typeof entry.runId === 'string' &&
    typeof entry.goal === 'string' &&
    typeof entry.openedAt === 'number'
  )
}

/** Sessions this browser opened, so the list works before a D1 replica is bound. */
export function recentSessions(): RecentSession[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter(isRecentSession) : []
  } catch {
    return []
  }
}

export function rememberSession(session: { runId: string; goal: string }) {
  const next = [
    { ...session, openedAt: Date.now() },
    ...recentSessions().filter((entry) => entry.runId !== session.runId),
  ].slice(0, LIMIT)

  localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
}

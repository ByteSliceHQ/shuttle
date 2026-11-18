import { z } from 'zod'

const STORAGE_KEY = 'shuttle.recent-sessions'
const LIMIT = 20

export interface RecentSession {
  readonly runId: string
  readonly goal: string
  readonly openedAt: number
}

const RecentSessionSchema = z.object({ runId: z.string(), goal: z.string(), openedAt: z.number() })

/** Sessions this browser opened, so the list works before a D1 replica is bound. */
export function recentSessions(): RecentSession[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    const entries = z.array(z.unknown()).safeParse(parsed)

    return entries.success
      ? entries.data.flatMap((entry) => {
          const session = RecentSessionSchema.safeParse(entry)
          return session.success ? [session.data] : []
        })
      : []
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

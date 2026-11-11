import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'shuttle.session-seen'
const SEEN_LIMIT = 250

export interface SeenSessionsSnapshot {
  readonly baselineAt: number
  readonly seen: Readonly<Record<string, number>>
}

const listeners = new Set<() => void>()
let cachedSnapshot: SeenSessionsSnapshot | null = null

function hasLocalStorage(): boolean {
  return typeof localStorage !== 'undefined'
}

function parseSnapshot(raw: string | null): SeenSessionsSnapshot | null {
  if (!raw) {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(raw)

    if (!parsed || typeof parsed !== 'object') {
      return null
    }

    const record = parsed as { baselineAt?: unknown; seen?: unknown }

    if (typeof record.baselineAt !== 'number' || !Number.isFinite(record.baselineAt)) {
      return null
    }

    const seen: Record<string, number> = {}

    if (record.seen && typeof record.seen === 'object') {
      for (const [key, value] of Object.entries(record.seen as Record<string, unknown>)) {
        if (typeof value === 'number' && Number.isFinite(value)) {
          seen[key] = value
        }
      }
    }

    return { baselineAt: record.baselineAt, seen }
  } catch {
    return null
  }
}

function persistSnapshot(snapshot: SeenSessionsSnapshot): void {
  if (!hasLocalStorage()) {
    return
  }

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
  } catch {
    // Storage quota errors should never break navigation.
  }
}

function trimSeen(seen: Readonly<Record<string, number>>): Readonly<Record<string, number>> {
  const entries = Object.entries(seen)

  if (entries.length <= SEEN_LIMIT) {
    return seen
  }

  return Object.fromEntries(
    entries.toSorted((left, right) => right[1] - left[1]).slice(0, SEEN_LIMIT),
  )
}

export function getSeenSessionsSnapshot(): SeenSessionsSnapshot {
  if (cachedSnapshot) {
    return cachedSnapshot
  }

  const fromStorage = hasLocalStorage() ? parseSnapshot(localStorage.getItem(STORAGE_KEY)) : null

  if (fromStorage) {
    cachedSnapshot = fromStorage
    return cachedSnapshot
  }

  cachedSnapshot = {
    baselineAt: Date.now(),
    seen: {},
  }

  persistSnapshot(cachedSnapshot)
  return cachedSnapshot
}

export function subscribeSeenSessions(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function markSessionSeen(runId: string, at = Date.now()): void {
  const current = getSeenSessionsSnapshot()
  const prev = current.seen[runId] ?? 0

  if (prev >= at) {
    return
  }

  cachedSnapshot = {
    baselineAt: current.baselineAt,
    seen: trimSeen({
      ...current.seen,
      [runId]: at,
    }),
  }

  persistSnapshot(cachedSnapshot)

  for (const listener of listeners) {
    listener()
  }
}

export function useSeenSessions(): SeenSessionsSnapshot {
  return useSyncExternalStore(
    subscribeSeenSessions,
    getSeenSessionsSnapshot,
    getSeenSessionsSnapshot,
  )
}

export function isSessionUnread(
  session: {
    readonly runId: string
    readonly unread?: boolean
    readonly lastCompletedAt?: number
  },
  options: {
    readonly activeRunId?: string | null
    readonly snapshot: SeenSessionsSnapshot
  },
): boolean {
  if (session.runId === options.activeRunId) {
    return false
  }

  if (typeof session.unread === 'boolean') {
    return session.unread
  }

  if (session.lastCompletedAt === undefined) {
    return false
  }

  const threshold = Math.max(options.snapshot.baselineAt, options.snapshot.seen[session.runId] ?? 0)

  return session.lastCompletedAt > threshold
}

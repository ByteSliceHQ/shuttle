import { indexedDbEventCache, type EventCache } from '@swirls/looms/react'

/**
 * Each run's events are kept on the device, so opening a session again downloads only what is
 * new. The store is one person's: a session kept for one sign-in is never shown to another on
 * the same browser, and signing out removes it.
 */
function databaseName(userId: string): string {
  return `shuttle-events:${userId}`
}

const caches = new Map<string, EventCache>()

export function eventCacheFor(userId: string): EventCache {
  const existing = caches.get(userId)

  if (existing) {
    return existing
  }

  const cache = indexedDbEventCache({ name: databaseName(userId) })
  caches.set(userId, cache)

  return cache
}

/** Removes what was kept for `userId`. Called when they sign out. */
export function forgetEventCache(userId: string): void {
  caches.delete(userId)

  try {
    window.indexedDB.deleteDatabase(databaseName(userId))
  } catch {
    // No storage to clear.
  }
}

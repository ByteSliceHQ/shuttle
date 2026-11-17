import { eventCacheFor } from '@/features/events/event-cache'
import { preloadRunStore, type RunStoreOptions } from '@swirls/looms/react'

import { storeTimings } from './timing'

/**
 * A session stays connected for a while after it is left, so going back to it shows it at once
 * instead of downloading its log again.
 */
const SESSION_RETAIN_MS = 5 * 60_000

/** How long a page change waits on a run's log before going ahead without it. */
const WAIT_MS = 4000

const options = new Map<string, RunStoreOptions>()

/**
 * How this app opens a run's event store, for the person signed in. The provider and the route
 * loaders are given the same object, so a store a loader opened is the one the page then uses.
 */
export function runStoreOptions(userId: string): RunStoreOptions {
  const existing = options.get(userId)

  if (existing) {
    return existing
  }

  const created: RunStoreOptions = {
    endpoint: '',
    // SSE holds one of the browser's six HTTP/1.1 connections per origin for each run store;
    // across a few tabs that starves route chunks and API calls. WebSockets have their own pool.
    transport: 'websocket',
    retainMs: SESSION_RETAIN_MS,
    cache: eventCacheFor(userId),
    observer: storeTimings,
  }

  options.set(userId, created)

  return created
}

/**
 * For a route loader: resolves once the run's log has been read as far as it went when asked,
 * so a page drawn from it arrives whole instead of saying "Connecting" and filling in as events
 * land. After a few seconds it goes ahead regardless. Never rejects: a page can always be shown
 * and fill in.
 */
export async function whenRunSynced(runId: string, userId: string): Promise<void> {
  await preloadRunStore(runId, {
    ...runStoreOptions(userId),
    signal: AbortSignal.timeout(WAIT_MS),
  }).catch(() => {})
}

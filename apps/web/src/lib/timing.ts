import type { StoreObserver } from '@swirls/looms/react'

/**
 * How the app felt, measured where it is felt: how long a session took to show, how long a
 * message took to be taken, how long a page change took. Reports are batched and sent to the
 * Worker, which writes them to its logs.
 */
export interface Timing {
  readonly type: string
  readonly durationMs?: number
  readonly runId?: string
  readonly eventCount?: number
  readonly cachedEvents?: number
  readonly optimistic?: boolean
  readonly status?: string
  readonly route?: string
  readonly message?: string
}

const FLUSH_MS = 5_000
const MAX_BATCH = 40

let queue: Timing[] = []
let timer: number | undefined

function flush(): void {
  if (timer !== undefined) {
    window.clearTimeout(timer)
    timer = undefined
  }

  if (queue.length === 0) {
    return
  }

  const body = JSON.stringify({ timings: queue })
  queue = []

  // `keepalive` lets the last batch leave with the page. A report that fails is not retried:
  // these are measurements, and losing some is better than a queue that grows.
  fetch('/timings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => {})
}

export function reportTiming(timing: Timing): void {
  queue.push(timing)

  if (queue.length >= MAX_BATCH) {
    flush()
    return
  }

  timer ??= window.setTimeout(flush, FLUSH_MS)
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flush()
    }
  })
}

/** Reports what each run's store measures about itself. */
export const storeTimings: StoreObserver = {
  observe(observation) {
    switch (observation.type) {
      case 'store.synced':
        reportTiming({
          type: observation.type,
          runId: observation.runId,
          durationMs: observation.durationMs,
          eventCount: observation.eventCount,
          cachedEvents: observation.cachedEvents,
        })

        return

      case 'store.connection':
        // Connecting and going live are every session's start; only trouble is worth a line.
        if (observation.status === 'reconnecting') {
          reportTiming({
            type: observation.type,
            runId: observation.runId,
            status: observation.status,
          })
        }

        return

      case 'commit.acked':
        reportTiming({
          type: observation.type,
          runId: observation.runId,
          durationMs: observation.durationMs,
          eventCount: observation.eventCount,
          optimistic: observation.optimistic,
        })

        return

      case 'commit.confirmed':
        reportTiming({
          type: observation.type,
          runId: observation.runId,
          durationMs: observation.durationMs,
        })

        return

      case 'commit.failed':
        reportTiming({
          type: observation.type,
          runId: observation.runId,
          durationMs: observation.durationMs,
          message: observation.message,
        })

        return

      default:
    }
  },
}

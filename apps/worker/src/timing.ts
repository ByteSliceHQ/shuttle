import type { RuntimeObservation, RuntimeObserver } from '@swirls/looms/runtime'

/**
 * How long things take, written as one JSON line each so they can be searched and charted from
 * the Worker's logs. `source` says where the number was measured: in a browser, or in a run.
 */
export interface TimingLine {
  readonly kind: 'shuttle.timing'
  readonly source: 'client' | 'run'
  readonly type: string
  readonly [field: string]: string | number | boolean | undefined
}

export function logTiming(line: Omit<TimingLine, 'kind'>): void {
  console.log(JSON.stringify({ kind: 'shuttle.timing', ...line }))
}

/** An append slower than this is worth a line; the rest would only be noise. */
const SLOW_APPEND_MS = 50

/**
 * Reports what a run's own clock sees: how long each wake ran, how long a cold start spent
 * loading its snapshot, appends that were slow or failed, and timers that fired late.
 */
export function runTimingObserver(runId: string): RuntimeObserver {
  let wokeAt: number | undefined

  return {
    observe(event: RuntimeObservation) {
      switch (event.type) {
        case 'run.wake':
          wokeAt = event.at
          return

        case 'run.park':
        case 'run.terminal':
          if (wokeAt !== undefined) {
            logTiming({
              source: 'run',
              type: 'run.wake',
              runId,
              durationMs: event.at - wokeAt,
              status: event.status,
            })

            wokeAt = undefined
          }

          return

        case 'snapshot.load':
          logTiming({
            source: 'run',
            type: event.type,
            runId,
            durationMs: event.latencyMs,
            outcome: event.outcome,
          })

          return

        case 'event.append':
          if (event.latencyMs >= SLOW_APPEND_MS || event.outcome !== 'ok') {
            logTiming({
              source: 'run',
              type: event.type,
              runId,
              durationMs: event.latencyMs,
              eventCount: event.eventCount,
              outcome: event.outcome,
            })
          }

          return

        case 'timer.late':
          logTiming({ source: 'run', type: event.type, runId, durationMs: event.latenessMs })
          return

        default:
      }
    },
  }
}

import type { Actor } from '../tenancy/access'
import { logTiming } from '../timing'

/** The measurements a browser may report. Anything else in a report is dropped. */
const CLIENT_TIMINGS = [
  'store.synced',
  'store.connection',
  'commit.acked',
  'commit.confirmed',
  'commit.failed',
  'route.resolved',
] as const

const MAX_TIMINGS = 50
const MAX_TEXT = 200

type ClientTiming = Record<string, string | number | boolean>

const NUMBERS = ['durationMs', 'eventCount', 'cachedEvents'] as const
const TEXTS = ['runId', 'status', 'route', 'message'] as const

/** Keeps only the fields a timing is known to carry, so a report cannot write arbitrary logs. */
export function readClientTiming(raw: unknown): ClientTiming | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }

  const input: Record<string, unknown> = { ...raw }
  const type = CLIENT_TIMINGS.find((known) => known === input.type)

  if (!type) {
    return null
  }

  const timing: ClientTiming = { type }

  for (const field of NUMBERS) {
    const value = input[field]

    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      timing[field] = Math.round(value)
    }
  }

  for (const field of TEXTS) {
    const value = input[field]

    if (typeof value === 'string' && value) {
      timing[field] = value.slice(0, MAX_TEXT)
    }
  }

  if (typeof input.optimistic === 'boolean') {
    timing.optimistic = input.optimistic
  }

  return timing
}

/**
 * Takes what a browser measured about how the app felt and writes it to the Worker's logs.
 *
 *   POST /timings    { timings: [{ type, durationMs?, runId?, … }] }
 *
 * Nothing is stored and nothing is read back: this only records numbers.
 */
export async function handleTimingRoutes(request: Request, actor: Actor): Promise<Response | null> {
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/timings') {
    return null
  }

  const body = (await request.json().catch(() => null)) as { timings?: unknown } | null
  const reported = Array.isArray(body?.timings) ? body.timings.slice(0, MAX_TIMINGS) : []

  for (const raw of reported) {
    const timing = readClientTiming(raw)

    if (timing) {
      const { type, ...fields } = timing

      logTiming({
        source: 'client',
        type: String(type),
        ...fields,
        orgId: actor.orgId,
        userId: actor.userId,
      })
    }
  }

  return new Response(null, { status: 204 })
}

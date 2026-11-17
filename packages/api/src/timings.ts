import { oc } from '@orpc/contract'
import { z } from 'zod'

/** The measurements a browser may report. A timing of any other type is dropped. */
export const CLIENT_TIMINGS = [
  'store.synced',
  'store.connection',
  'commit.acked',
  'commit.confirmed',
  'commit.failed',
  'route.resolved',
] as const

export const MAX_TIMINGS = 50
const MAX_TEXT = 200

// A field of the wrong kind is dropped, not refused: these are measurements, and one bad value
// should not lose the rest of the batch.
const count = z
  .number()
  .nonnegative()
  .transform((value) => Math.round(value))
  .optional()
  .catch(undefined)

const text = z
  .string()
  .min(1)
  .transform((value) => value.slice(0, MAX_TEXT))
  .optional()
  .catch(undefined)

/** Only the fields a timing is known to carry, so a report cannot write arbitrary logs. */
export const ClientTiming = z.object({
  type: z.string(),
  durationMs: count,
  eventCount: count,
  cachedEvents: count,
  runId: text,
  status: text,
  route: text,
  message: text,
  optimistic: z.boolean().optional().catch(undefined),
})
export type ClientTiming = z.infer<typeof ClientTiming>

export const timingsContract = {
  /**
   * Takes what a browser measured about how the app felt. Nothing is stored and nothing is read
   * back, so the answer has no body.
   */
  report: oc
    .route({ method: 'POST', path: '/timings', successStatus: 204 })
    .input(z.object({ timings: z.array(ClientTiming).default([]) })),
}

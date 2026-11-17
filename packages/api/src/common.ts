import { z } from 'zod'

/** The session a `/sessions/{id}/…` path names. */
export const SessionParams = z.object({ id: z.string().min(1) })

export const Ok = z.object({ ok: z.literal(true) })

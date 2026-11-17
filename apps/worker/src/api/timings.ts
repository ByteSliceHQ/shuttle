import { CLIENT_TIMINGS, MAX_TIMINGS } from '@shuttle/api'

import { logTiming } from '../timing'
import { api } from './base'

const known: ReadonlySet<string> = new Set(CLIENT_TIMINGS)

export const timingsRouter = {
  /**
   * Takes what a browser measured about how the app felt and writes it to the Worker's logs.
   *
   *   POST /timings    { timings: [{ type, durationMs?, runId?, … }] }
   *
   * Nothing is stored and nothing is read back: this only records numbers.
   */
  report: api.timings.report.handler(({ input, context: { actor } }) => {
    for (const { type, ...fields } of input.timings.slice(0, MAX_TIMINGS)) {
      if (known.has(type)) {
        logTiming({ source: 'client', type, ...fields, orgId: actor.orgId, userId: actor.userId })
      }
    }
  }),
}

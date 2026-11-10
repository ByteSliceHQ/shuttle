import { defineModule, type DefinitionRef } from '@swirls/looms/core'

import { codingSession } from './definitions'
import { brief, routing, transcript } from './projections'
import { shuttleModule } from './scope'
import { reroute, say } from './signals'
import { createSessionThread } from './thread'

export interface ShuttleSessionOptions {
  readonly definitions?: readonly DefinitionRef[]
}

export function shuttleSession(options: ShuttleSessionOptions = {}) {
  return defineModule(shuttleModule, () => ({
    definitions: options.definitions ?? [codingSession],
    threads: {
      'shuttle-session': createSessionThread(),
    },
    projections: {
      brief,
      routing,
      transcript,
    },
    signals: {
      say,
      reroute,
    },
  }))
}

export { say, reroute, brief, routing, transcript, codingSession }
export type { InterjectionKind, SessionState } from './thread'

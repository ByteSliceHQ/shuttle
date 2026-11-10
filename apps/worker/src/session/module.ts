import { defineModule, type DefinitionRef } from '@swirls/looms/core'

import { createBindSandboxEffect } from './bind-sandbox'
import { codingSession } from './definitions'
import { brief, routing, transcript } from './projections'
import { shuttleModule } from './scope'
import { reroute, say } from './signals'
import { createSessionThread } from './thread'

export interface ShuttleSessionOptions {
  readonly definitions?: readonly DefinitionRef[]
  readonly storage?: DurableObjectStorage
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
    effects: {
      bindSandbox: createBindSandboxEffect(options.storage),
    },
  }))
}

export { say, reroute, brief, routing, transcript, codingSession }
export type { InterjectionKind, SessionState } from './thread'

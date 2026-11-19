import { defineModule, type DefinitionRef } from '@swirls/looms/core'

import type { EngineEnv } from '../env'
import { createBindSandboxEffect } from './bind-sandbox'
import { codingSession, reviewSession } from './definitions'
import { createPreparePrPublishGateEffect } from './prepare-pr-publish-gate'
import { brief, routing, transcript, work } from './projections'
import { createPublishPullRequestEffect } from './publish-pr'
import { shuttleModule } from './scope'
import { requestPullRequest, reroute, say } from './signals'
import { createSubmitReviewEffect } from './submit-review'
import { thinkingMiddleware } from './thinking-middleware'
import { createSessionThread } from './thread'

export interface ShuttleSessionOptions {
  readonly definitions?: readonly DefinitionRef[]
  readonly storage?: DurableObjectStorage
  readonly env: EngineEnv
}

export function shuttleSession(options: ShuttleSessionOptions) {
  const { env, storage } = options

  return defineModule(shuttleModule, () => ({
    definitions: options.definitions ?? [codingSession, reviewSession],
    threads: {
      'shuttle-session': createSessionThread(),
    },
    projections: {
      brief,
      routing,
      transcript,
      work,
    },
    signals: {
      say,
      reroute,
      requestPullRequest,
    },
    effects: {
      bindSandbox: createBindSandboxEffect(storage),
      preparePrPublishGate: createPreparePrPublishGateEffect(env, storage),
      publishPullRequest: createPublishPullRequestEffect(env, storage),
      submitReview: createSubmitReviewEffect(env, storage),
    },
    middleware: [thinkingMiddleware],
  }))
}

export { say, reroute, brief, routing, transcript, work, codingSession, reviewSession }
export type { InterjectionKind, SessionState } from './thread'

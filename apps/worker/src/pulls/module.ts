import { defineModule } from '@swirls/looms/core'

import type { ShuttleEnv } from '../env'
import { pullsDefinition } from './definitions'
import { createLaunchReviewEffect } from './launch-review'
import { pullInbox } from './projections'
import { pullsModule } from './scope'
import {
  ingestWebhook,
  recordPublished,
  recordReview,
  requestReview,
  setRepoPolicy,
  upsertPull,
} from './signals'
import { createPullsThread } from './thread'

export interface PullsModuleOptions {
  readonly env?: ShuttleEnv
}

export function pulls(options: PullsModuleOptions = {}) {
  const env =
    options.env ??
    ({
      LOOMS_RUN: {} as DurableObjectNamespace,
      SANDBOX: {} as DurableObjectNamespace,
      EVENT_FIREHOSE: {} as DurableObjectNamespace,
    } satisfies ShuttleEnv)

  return defineModule(pullsModule, () => ({
    definitions: [pullsDefinition],
    threads: {
      'shuttle-pulls': createPullsThread(),
    },
    projections: {
      pullInbox,
    },
    signals: {
      ingestWebhook,
      upsertPull,
      recordPublished,
      recordReview,
      setRepoPolicy,
      requestReview,
    },
    effects: {
      launchReviewSession: createLaunchReviewEffect(env),
    },
  }))
}

export {
  ingestWebhook,
  upsertPull,
  recordPublished,
  recordReview,
  setRepoPolicy,
  requestReview,
  pullInbox,
  pullsDefinition,
}

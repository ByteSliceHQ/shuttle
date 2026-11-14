import { defineModule } from '@swirls/looms/core'

import type { ShuttleEnv } from '../env'
import { pullsDefinition } from './definitions'
import { createLaunchReviewEffect } from './launch-review'
import { pullInbox } from './projections'
import { pullsModule } from './scope'
import {
  ingestWebhook,
  linkReviewSession,
  recordPublished,
  recordReview,
  requestReview,
  setRepoPolicy,
  upsertPull,
} from './signals'
import { createPullsThread } from './thread'

export interface PullsModuleOptions {
  readonly env: ShuttleEnv
}

export function pulls(options: PullsModuleOptions) {
  const { env } = options

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
      linkReviewSession,
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
  linkReviewSession,
  setRepoPolicy,
  requestReview,
  pullInbox,
  pullsDefinition,
}

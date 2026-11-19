import { defineModule } from '@swirls/looms/core'

import type { EngineEnv } from '../env'
import { pullsDefinition } from './definitions'
import { createLaunchReviewEffect } from './launch-review'
import { pullInbox } from './projections'
import { pullsModule } from './scope'
import {
  ingestWebhook,
  linkReviewSession,
  recordPublished,
  recordReview,
  removeComment,
  requestReview,
  setRepoPolicy,
  setThreadResolution,
  syncThreads,
  upsertComment,
  upsertPull,
} from './signals'
import { createPullsThread } from './thread'
import { pullThreads } from './threads'

export interface PullsModuleOptions {
  readonly env: EngineEnv
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
      pullThreads,
    },
    signals: {
      ingestWebhook,
      upsertPull,
      recordPublished,
      recordReview,
      linkReviewSession,
      upsertComment,
      removeComment,
      setThreadResolution,
      syncThreads,
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

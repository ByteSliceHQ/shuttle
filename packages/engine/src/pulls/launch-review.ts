import { Schema } from 'effect'

import { orgOfRun } from '@shuttle/api'

import { workspaceRunId } from '../config'
import type { EngineEnv } from '../env'
import { loomsStub } from '../looms-stub'
import { admitSessionStart, openSessionStart, type SessionStartPort } from '../ports/session-start'
import { requestSession } from '../workspace/signals'
import { pullsModule } from './scope'
import { reviewerLinked } from './signals'

export function createLaunchReviewEffect(
  env: EngineEnv,
  sessionStart: SessionStartPort = openSessionStart,
) {
  return pullsModule.effect({
    type: 'pulls.launchReviewSession',
    placement: 'local',
    input: Schema.Struct({
      runId: Schema.String,
      folderId: Schema.String,
      fullName: Schema.String,
      number: Schema.Finite,
      headSha: Schema.String,
      baseSha: Schema.String,
    }),
    execute: async (input, ctx) => {
      // Nobody asked for this review, so nobody is named; the host still decides if it may start.
      await admitSessionStart(sessionStart, {
        kind: 'auto-review',
        orgId: orgOfRun(ctx.runId) ?? '',
        acting: null,
        repos: [input.fullName],
      })

      const stub = loomsStub(env.LOOMS_RUN, workspaceRunId(env, orgOfRun(ctx.runId)))

      await stub.signal([
        requestSession({
          runId: input.runId,
          folderId: input.folderId,
          goal: `Review ${input.fullName}#${input.number}`,
          lessons: [],
          playbookVersion: 0,
          playbookRunId: null,
          definitionName: 'review',
          pull: {
            fullName: input.fullName,
            number: input.number,
            headSha: input.headSha,
            baseSha: input.baseSha,
          },
        }),
      ])

      // Linked now, not when a review is submitted, so the pull request shows its reviewer.
      return [
        reviewerLinked({ fullName: input.fullName, number: input.number, runId: input.runId }),
      ]
    },
  })
}

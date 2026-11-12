import { Schema } from 'effect'

import { pullsRunId } from '../config'
import type { ShuttleEnv } from '../env'
import { submitPullReview, type PullReviewVerdict } from '../github/pulls'
import { loomsStub } from '../looms-stub'
import { recordReview } from '../pulls/signals'
import { readSandboxBinding } from './bind-sandbox'
import { shuttleModule } from './scope'

export function createSubmitReviewEffect(env: ShuttleEnv, storage?: DurableObjectStorage) {
  return shuttleModule.effect({
    type: 'shuttle.submitReview',
    placement: 'local',
    input: Schema.Struct({
      approvalId: Schema.String,
      threadId: Schema.optional(Schema.String),
      fullName: Schema.String,
      number: Schema.Finite,
      commitId: Schema.String,
      summary: Schema.String,
      verdict: Schema.Union([
        Schema.Literal('approve'),
        Schema.Literal('request_changes'),
        Schema.Literal('comment'),
      ]),
      comments: Schema.Array(
        Schema.Struct({
          path: Schema.String,
          line: Schema.Finite,
          side: Schema.Union([Schema.Literal('LEFT'), Schema.Literal('RIGHT')]),
          body: Schema.String,
        }),
      ),
    }),
    execute: async (input, ctx) => {
      const binding = await readSandboxBinding(storage, ctx.runId)
      const repo = binding?.repos.find((item) => item.fullName === input.fullName)

      if (!repo) {
        return []
      }

      let verdict: PullReviewVerdict

      switch (input.verdict) {
        case 'approve':
          verdict = 'approve'
          break
        case 'request_changes':
          verdict = 'request_changes'
          break
        case 'comment':
          verdict = 'comment'
          break

        default: {
          const exhaustive: never = input.verdict
          throw new Error(`Unknown verdict: ${exhaustive}`)
        }
      }

      await submitPullReview(env, {
        repo: {
          installationId: repo.installationId,
          owner: repo.owner,
          name: repo.name,
          fullName: repo.fullName,
          defaultBranch: repo.defaultBranch,
          private: repo.private,
        },
        number: input.number,
        commitId: input.commitId,
        body: input.summary,
        verdict,
        comments: input.comments,
      })

      const pullsStub = loomsStub(env.LOOMS_RUN, pullsRunId(env))

      const mappedVerdict =
        verdict === 'approve'
          ? ('approved' as const)
          : verdict === 'request_changes'
            ? ('changes_requested' as const)
            : ('commented' as const)

      const signals = recordReview({
        fullName: input.fullName,
        number: input.number,
        runId: ctx.runId,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        verdict: mappedVerdict,
        updatedAt: Date.now(),
      })

      await pullsStub.signal(Array.isArray(signals) ? signals : [signals])

      return [
        shuttleModule.input('review.submitted', {
          fullName: input.fullName,
          number: input.number,
          verdict: input.verdict,
          commentCount: input.comments.length,
        }),
      ]
    },
  })
}

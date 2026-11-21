import { Schema } from 'effect'

import { getPullRequest, listPullFiles, submitPullReview } from '@shuttle/git/github/pulls'

import { bodyWithUnanchored, partitionByAnchor } from '../agents/tools/review'
import { pullsRunId } from '../config'
import type { EngineEnv } from '../env'
import { loomsStub } from '../looms-stub'
import { recordReview } from '../pulls/signals'
import { orgOfRun } from '../tenancy/run-id'
import { readSandboxBinding } from './bind-sandbox'
import { shuttleModule } from './scope'

export function createSubmitReviewEffect(env: EngineEnv, storage?: DurableObjectStorage) {
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
      const failed = (error: string) => [
        shuttleModule.input('review.submit_failed', { approvalId: input.approvalId, error }),
      ]

      const binding = await readSandboxBinding(storage, ctx.runId)
      const repo = binding?.repos.find((item) => item.fullName === input.fullName)

      if (!repo) {
        return failed(
          input.fullName !== ''
            ? `${input.fullName} is not linked to this session, so the review cannot be sent.`
            : 'The review does not say which pull request it is for.',
        )
      }

      const { verdict } = input
      let unanchoredCount = 0

      try {
        // Checked against the pull request as it is now: one comment on a line GitHub cannot
        // place makes it refuse the whole review, so those are moved into the body.
        const [files, commitId] = await Promise.all([
          listPullFiles(env, repo, input.number),
          input.commitId !== ''
            ? input.commitId
            : getPullRequest(env, repo, input.number).then((pull) => pull.headSha),
        ])

        const { anchored, unanchored } = partitionByAnchor(input.comments, files)

        unanchoredCount = unanchored.length

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
          commitId,
          body: bodyWithUnanchored(input.summary, unanchored),
          verdict,
          comments: anchored,
        })
      } catch (cause) {
        return failed(cause instanceof Error ? cause.message : String(cause))
      }

      const pullsStub = loomsStub(env.LOOMS_RUN, pullsRunId(env, orgOfRun(ctx.runId)))

      const mappedVerdict =
        verdict === 'approve'
          ? ('approved' as const)
          : verdict === 'request_changes'
            ? ('changes_requested' as const)
            : ('commented' as const)

      const reviewedAt = {
        fullName: input.fullName,
        number: input.number,
        runId: ctx.runId,
        verdict: mappedVerdict,
        updatedAt: Date.now(),
      }

      const signals = recordReview(
        input.threadId !== undefined && input.threadId !== ''
          ? { ...reviewedAt, threadId: input.threadId }
          : reviewedAt,
      )

      await pullsStub.signal(Array.isArray(signals) ? signals : [signals])

      const submitted = {
        fullName: input.fullName,
        number: input.number,
        verdict: input.verdict,
        commentCount: input.comments.length - unanchoredCount,
      }

      return [
        shuttleModule.input(
          'review.submitted',
          unanchoredCount > 0 ? { ...submitted, unanchoredCount } : submitted,
        ),
      ]
    },
  })
}

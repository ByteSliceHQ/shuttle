import { Schema } from 'effect'

import { orgOfRun } from '@shuttle/api'

import { neverExpire, policyDecision, type ApprovalPolicy } from '../ports/approvals'
import { readSessionAccess } from '../tenancy/access'
import { readSandboxBinding } from './bind-sandbox'
import { policyDecided } from './publish-effects'
import { shuttleModule } from './scope'

const VerdictSchema = Schema.Union([
  Schema.Literal('approve'),
  Schema.Literal('request_changes'),
  Schema.Literal('comment'),
])

/**
 * Asks the host's approval policy about a review an agent has asked to submit, as its gate opens.
 * The reviewer invokes it beside the gate. A decision is returned as the `approval.decided` a
 * person would have sent, carrying the review as it was drafted; with none, nothing is returned
 * and the gate waits for a person.
 */
export function createDecideReviewGateEffect(
  storage?: DurableObjectStorage,
  approvals: ApprovalPolicy = neverExpire,
) {
  return shuttleModule.effect({
    type: 'shuttle.decideReviewGate',
    placement: 'local',
    input: Schema.Struct({
      approvalId: Schema.String,
      fullName: Schema.String,
      number: Schema.Finite,
      commitId: Schema.String,
      summary: Schema.String,
      verdict: VerdictSchema,
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
      // A decision goes to the session's own thread, which only a binding that recorded it names.
      const session = (await readSandboxBinding(storage, ctx.runId))?.session

      if (session === undefined) {
        return []
      }

      const decision = await policyDecision(approvals, {
        kind: 'submit-review',
        approvalId: input.approvalId,
        orgId: orgOfRun(ctx.runId),
        ownerId: storage ? ((await readSessionAccess(storage))?.ownerId ?? null) : null,
        hostMetadata: session.hostMetadata,
        proposal: {
          repository: input.fullName,
          number: input.number,
          verdict: input.verdict,
          summary: input.summary,
          commentCount: input.comments.length,
        },
      })

      if (decision === null) {
        return []
      }

      if (decision === 'reject') {
        return [
          policyDecided(session.threadId, {
            approvalId: input.approvalId,
            actionId: 'discard',
            outcome: 'reject',
          }),
        ]
      }

      return [
        policyDecided(session.threadId, {
          approvalId: input.approvalId,
          actionId: 'submit',
          outcome: 'approve',
          // What the gate's form would send back unchanged: the review as the agent drafted it.
          payload: {
            summary: input.summary,
            verdict: input.verdict,
            comments: input.comments.map((comment) => ({ ...comment })),
            fullName: input.fullName,
            number: input.number,
            commitId: input.commitId,
          },
        }),
      ]
    },
  })
}

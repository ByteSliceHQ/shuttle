import { Schema } from 'effect'

import type { ShuttleEnv } from '../env'
import { sandboxStub } from '../env'
import { readSandboxBinding, sandboxNameForSession } from './bind-sandbox'
import { prepareSessionSandbox } from './handoff'
import { shuttleModule } from './scope'
import { readSessionStacks } from './session-stacks'
import { stackContextForLayer, stackKey } from './stack-state'

const PreparePrPublishGateSchema = Schema.Struct({
  approvalId: Schema.String,
  title: Schema.String,
  body: Schema.String,
  draft: Schema.Boolean,
  repos: Schema.Array(Schema.String),
  repo: Schema.optional(Schema.String),
})

const PUBLISH_ACTIONS = [
  { id: 'draft', label: 'Publish as draft', outcome: 'approve' as const },
  { id: 'publish', label: 'Publish', outcome: 'approve' as const },
  { id: 'discard', label: 'Discard', outcome: 'reject' as const },
]

/**
 * Resolve the worktree current layer, stamp `pr.proposed`, and open the publish
 * approval gate with stack labels already filled in. Invoked from the proposing
 * agent tool so `approval.requested` lands on that thread.
 */
export function createPreparePrPublishGateEffect(env: ShuttleEnv, storage?: DurableObjectStorage) {
  return shuttleModule.effect({
    type: 'shuttle.preparePrPublishGate',
    placement: 'local',
    input: PreparePrPublishGateSchema,
    execute: async (input, ctx) => {
      const binding = await readSandboxBinding(storage, ctx.runId)
      const stacks = await readSessionStacks(storage, ctx.runId)

      const repoArg = input.repo || input.repos[0] || ''

      const linked =
        binding?.repos.find((repo) => repo.name === repoArg || repo.fullName === repoArg) ??
        binding?.repos[0] ??
        null

      let stackId: number | null = null
      let layer: number | null = null

      let repoName: string | null =
        linked?.name ??
        (repoArg ? (repoArg.includes('/') ? (repoArg.split('/')[1] ?? repoArg) : repoArg) : null)

      if (binding && linked) {
        const sandbox = sandboxStub(
          env,
          await sandboxNameForSession(env, storage, ctx.runId, binding.sandboxName),
        )

        await prepareSessionSandbox(env, storage, ctx.runId, binding)
        const status = await sandbox.stackStatus(ctx.runId, linked.name, linked.defaultBranch)
        stackId = status.currentStack
        layer = status.currentLayer
        repoName = linked.name
      }

      const { parentPull, restacks } =
        stackId != null && layer != null && repoName
          ? stackContextForLayer(
              stacks[stackKey(repoName, stackId)],
              layer,
              linked?.fullName ?? repoName,
            )
          : { parentPull: null, restacks: [] as const }

      const parentPullLabel = parentPull ? `${parentPull.fullName}#${parentPull.number}` : ''

      const restackLabel =
        restacks.length > 0 ? restacks.map((number) => `#${number}`).join(', ') : ''

      return [
        shuttleModule.input('pr.proposed', {
          approvalId: input.approvalId,
          title: input.title,
          body: input.body,
          draft: input.draft,
          repos: [...input.repos],
          ...(repoName ? { repo: repoName } : {}),
          ...(stackId != null ? { stackId } : {}),
          ...(layer != null ? { layer } : {}),
          parentPull,
          restacks: [...restacks],
        }),
        {
          type: 'approval.requested' as const,
          payload: {
            approvalId: input.approvalId,
            title: 'Publish pull requests?',
            description: input.title,
            schema: {
              type: 'object',
              properties: {
                title: { type: 'string', default: input.title },
                body: { type: 'string', default: input.body },
                draft: { type: 'boolean', default: input.draft },
                repos: { type: 'array', items: { type: 'string' }, default: [...input.repos] },
                repo: { type: 'string', default: repoName ?? '' },
                stackId: { type: 'number', default: stackId ?? 1 },
                layer: { type: 'number', default: layer ?? 1 },
                parentPullLabel: { type: 'string', default: parentPullLabel },
                restackLabel: { type: 'string', default: restackLabel },
              },
            },
            actions: PUBLISH_ACTIONS,
          },
          threadId: ctx.threadId,
        },
      ]
    },
  })
}

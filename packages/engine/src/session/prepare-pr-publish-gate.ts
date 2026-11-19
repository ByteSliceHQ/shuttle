import { Schema } from 'effect'

import { shellQuote } from '@shuttle/sandbox/exec-argv'
import { worktreeRepoPath } from '@shuttle/sandbox/workspace'

import type { EngineEnv } from '../env'
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
  /** The thread the card shows on. Defaults to the thread that invoked the gate. */
  threadId: Schema.optional(Schema.String),
  /** The title when none is given and the commits do not offer one, such as the session goal. */
  fallbackTitle: Schema.optional(Schema.String),
})

const PUBLISH_ACTIONS = [
  { id: 'draft', label: 'Publish as draft', outcome: 'approve' as const },
  { id: 'publish', label: 'Publish', outcome: 'approve' as const },
  { id: 'discard', label: 'Discard', outcome: 'reject' as const },
]

/**
 * When the layer already has a pull request, publishing pushes to it: GitHub keeps its draft
 * state, so asking "draft or not" would offer a choice that does nothing.
 */
const UPDATE_ACTIONS = [
  { id: 'update', label: 'Push update', outcome: 'approve' as const },
  { id: 'discard', label: 'Discard', outcome: 'reject' as const },
]

/** What the approval asks: to open pull requests, or to update the one the layer already has. */
export function publishQuestion(existingPullLabel: string | null): {
  readonly title: string
  readonly actions: typeof PUBLISH_ACTIONS | typeof UPDATE_ACTIONS
} {
  return existingPullLabel !== null && existingPullLabel !== ''
    ? { title: `Update ${existingPullLabel}?`, actions: UPDATE_ACTIONS }
    : { title: 'Publish pull requests?', actions: PUBLISH_ACTIONS }
}

/**
 * Resolve the worktree current layer, stamp `pr.proposed`, and open the publish
 * approval gate with stack labels already filled in. Invoked from the proposing
 * agent tool so `approval.requested` lands on that thread.
 */
/** True for a string that is neither missing nor empty. */
function isPresent(value: string | undefined | null): value is string {
  return value !== undefined && value !== null && value !== ''
}

export function createPreparePrPublishGateEffect(env: EngineEnv, storage?: DurableObjectStorage) {
  return shuttleModule.effect({
    type: 'shuttle.preparePrPublishGate',
    placement: 'local',
    input: PreparePrPublishGateSchema,
    execute: async (input, ctx) => {
      const binding = await readSandboxBinding(storage, ctx.runId)
      const stacks = await readSessionStacks(storage, ctx.runId)

      const repoArg = isPresent(input.repo) ? input.repo : (input.repos[0] ?? '')

      const linked =
        binding?.repos.find((repo) => repo.name === repoArg || repo.fullName === repoArg) ??
        binding?.repos[0] ??
        null

      let stackId: number | null = null
      let layer: number | null = null
      let title = input.title.trim()
      let body = input.body

      let repoName: string | null =
        linked?.name ??
        (repoArg !== ''
          ? repoArg.includes('/')
            ? (repoArg.split('/')[1] ?? repoArg)
            : repoArg
          : null)

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

        // Asked for from the PR button, with nothing written: the layer's commits say it best.
        if (title === '') {
          const current = status.layers.find((entry) => entry.layer === status.currentLayer)

          // Layer 1 sits on the commit the session started from; a higher one on the layer below.
          const base =
            status.currentLayer === 1
              ? (status.stacks.find((entry) => entry.stack === status.currentStack)?.baseSha ??
                current?.parentBranch)
              : current?.parentBranch

          const written = isPresent(base)
            ? await describeCommits(sandbox, worktreeRepoPath(ctx.runId, linked.name), base).catch(
                () => null,
              )
            : null

          title = written?.title ?? ''
          body = body.trim() !== '' ? body : (written?.body ?? '')
        }
      }

      if (title === '') {
        title = input.fallbackTitle?.trim() ?? ''
      }

      const { parentPull, restacks } =
        stackId !== null && layer !== null && isPresent(repoName)
          ? stackContextForLayer(
              stacks[stackKey(repoName, stackId)],
              layer,
              linked?.fullName ?? repoName,
            )
          : { parentPull: null, restacks: [] as const }

      const parentPullLabel = parentPull ? `${parentPull.fullName}#${parentPull.number}` : ''

      // The pull request this layer already has, which publishing will update instead of opening.
      const existingPull =
        stackId !== null && layer !== null && isPresent(repoName)
          ? (stacks[stackKey(repoName, stackId)]?.layers.find((entry) => entry.layer === layer)
              ?.pull ?? null)
          : null

      const existingPullLabel =
        existingPull === null ? '' : `${linked?.fullName ?? repoName}#${existingPull.number}`

      const question = publishQuestion(existingPullLabel === '' ? null : existingPullLabel)

      const restackLabel =
        restacks.length > 0 ? restacks.map((number) => `#${number}`).join(', ') : ''

      const shownTitle = title === '' ? 'Shuttle changes' : title

      return [
        shuttleModule.input('pr.proposed', {
          approvalId: input.approvalId,
          title: shownTitle,
          body,
          draft: input.draft,
          repos: [...input.repos],
          repo: isPresent(repoName) ? repoName : undefined,
          stackId: stackId ?? undefined,
          layer: layer ?? undefined,
          parentPull,
          restacks: [...restacks],
        }),
        {
          type: 'approval.requested' as const,
          payload: {
            approvalId: input.approvalId,
            title: question.title,
            description: shownTitle,
            schema: {
              type: 'object',
              properties: {
                title: { type: 'string', default: shownTitle },
                body: { type: 'string', default: body },
                draft: { type: 'boolean', default: input.draft },
                repos: { type: 'array', items: { type: 'string' }, default: [...input.repos] },
                repo: { type: 'string', default: repoName ?? '' },
                stackId: { type: 'number', default: stackId ?? 1 },
                layer: { type: 'number', default: layer ?? 1 },
                parentPullLabel: { type: 'string', default: parentPullLabel },
                restackLabel: { type: 'string', default: restackLabel },
                existingPullLabel: { type: 'string', default: existingPullLabel },
                existingPullUrl: { type: 'string', default: existingPull?.url ?? '' },
                existingPullDraft: { type: 'boolean', default: existingPull?.draft ?? false },
              },
            },
            actions: question.actions,
          },
          threadId: input.threadId ?? ctx.threadId,
        },
      ]
    },
  })
}

/**
 * A title and body for a pull request, from the commits on top of `base`: one commit gives its
 * own message; several give the first as the title and list them all in the body. Null when
 * there are none, as when the work is still uncommitted.
 */
export async function describeCommits(
  sandbox: {
    exec(command: string, options?: { cwd?: string }): Promise<{ stdout: string; exitCode: number }>
  },
  cwd: string,
  base: string,
): Promise<{ title: string; body: string } | null> {
  const log = await sandbox.exec(
    `git log --reverse --format='%s%x1f%b%x1e' ${shellQuote(`${base}..HEAD`)} 2>/dev/null`,
    { cwd },
  )

  if (log.exitCode !== 0) {
    return null
  }

  return commitsToPullText(log.stdout)
}

/** Parses `git log --format='%s%x1f%b%x1e'` output into a pull request title and body. */
export function commitsToPullText(log: string): { title: string; body: string } | null {
  const commits = log
    .split('\x1e')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      const [subject = '', body = ''] = entry.split('\x1f')

      return { subject: subject.trim(), body: body.trim() }
    })
    .filter((commit) => commit.subject !== '')

  const [first] = commits

  if (!first) {
    return null
  }

  if (commits.length === 1) {
    return { title: first.subject, body: first.body }
  }

  return {
    title: first.subject,
    body: commits.map((commit) => `- ${commit.subject}`).join('\n'),
  }
}

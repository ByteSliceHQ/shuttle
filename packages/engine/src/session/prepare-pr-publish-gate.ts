import { Schema } from 'effect'

import { orgOfRun } from '@shuttle/api'
import { shellQuote } from '@shuttle/sandbox/exec-argv'
import { worktreeRepoPath } from '@shuttle/sandbox/workspace'

import type { EngineEnv } from '../env'
import { sandboxStub } from '../env'
import { expiryOf, neverExpire, policyDecision, type ApprovalPolicy } from '../ports/approvals'
import { readSessionAccess } from '../tenancy/access'
import { readSandboxBinding, sandboxNameForSession } from './bind-sandbox'
import { prepareSessionSandbox } from './handoff'
import { policyDecided } from './publish-effects'
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

export function createPreparePrPublishGateEffect(
  env: EngineEnv,
  storage?: DurableObjectStorage,
  approvals: ApprovalPolicy = neverExpire,
) {
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
      let branch: string | null = null
      let baseBranch: string | null = null
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

        const current = status.layers.find((entry) => entry.layer === status.currentLayer)

        branch = current?.branch ?? null

        // Layer 1 is opened against the default branch; a higher one against the layer below.
        baseBranch =
          status.currentLayer === 1 ? linked.defaultBranch : (current?.parentBranch ?? null)

        // Asked for from the PR button, with nothing written: the layer's commits say it best.
        if (title === '') {
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

      const request = {
        kind: 'publish-pull-request' as const,
        approvalId: input.approvalId,
        orgId: orgOfRun(ctx.runId),
      }

      const expiresAt = expiryOf(approvals, request, Date.now())

      // The host's policy is asked here, in the effect that opens the gate, so its answer is
      // recorded with the gate and never asked for again. A decision goes to the session's own
      // thread, which a binding from before that thread was recorded cannot name: such a gate
      // waits for a person, as it always has.
      const session = binding?.session

      const decision =
        session === undefined
          ? null
          : await policyDecision(approvals, {
              ...request,
              ownerId: storage ? ((await readSessionAccess(storage))?.ownerId ?? null) : null,
              hostMetadata: session.hostMetadata,
              proposal: {
                title: shownTitle,
                body,
                draft: input.draft,
                repositories: publishedRepositories(binding?.repos ?? [], repoName, input.repos),
                branch,
                baseBranch,
                stack:
                  stackId === null || layer === null
                    ? null
                    : {
                        id: stackId,
                        layer,
                        parentPullRequest: parentPull
                          ? { repository: parentPull.fullName, number: parentPull.number }
                          : null,
                        restacks: [...restacks],
                      },
                existingPullRequest: existingPull
                  ? { number: existingPull.number, url: existingPull.url }
                  : null,
              },
            })

      const decided =
        session === undefined || decision === null
          ? []
          : [
              policyDecided(session.threadId, {
                approvalId: input.approvalId,
                actionId: decision === 'approve' ? 'approve' : 'discard',
                outcome: decision,
              }),
            ]

      const proposal = {
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
        expiresAt,
      }

      return [
        // Addressed to the session's thread when it is known, so the session has taken up the
        // proposal before a decision that follows it in this batch arrives. Otherwise it reaches
        // the session through its mailbox, from the thread that proposed it.
        session === undefined
          ? shuttleModule.input('pr.proposed', proposal)
          : {
              ...shuttleModule.input('pr.proposed', { ...proposal, proposedBy: ctx.threadId }),
              threadId: session.threadId,
            },
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
        ...decided,
      ]
    },
  })
}

/**
 * The repositories a publish would push to, as `owner/name`: the proposing layer's, else the ones
 * the proposal names, else every repository linked to the session. A name the session has no
 * repository for is kept as it was given.
 */
export function publishedRepositories(
  linked: readonly { readonly name: string; readonly fullName: string }[],
  repo: string | null,
  repos: readonly string[],
): string[] {
  const fullNameOf = (name: string) =>
    linked.find((entry) => entry.name === name || entry.fullName === name)?.fullName ?? name

  if (isPresent(repo)) {
    return [fullNameOf(repo)]
  }

  return repos.length > 0 ? repos.map(fullNameOf) : linked.map((entry) => entry.fullName)
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

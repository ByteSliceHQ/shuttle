import { Schema } from 'effect'

import { pullsRunId } from '../config'
import type { ShuttleEnv } from '../env'
import { sandboxStub } from '../env'
import { loomsStub } from '../looms-stub'
import { recordPublished } from '../pulls/signals'
import type { LinkedSandboxRepo } from '../sandbox/workspace'
import { orgOfRun } from '../tenancy/run-id'
import { readSandboxBinding } from './bind-sandbox'
import { githubMirror, mirrorRepoStack, type MirroredStack } from './mirror-stack'
import { shuttleModule } from './scope'
import { writeSessionStacks } from './session-stacks'
import { stackKey, type SessionRepoStack, type SessionStacks } from './stack-state'

const StackLayerSchema = Schema.Struct({
  layer: Schema.Finite,
  branch: Schema.String,
  parentBranch: Schema.String,
  pull: Schema.NullOr(
    Schema.Struct({
      number: Schema.Finite,
      url: Schema.String,
      draft: Schema.Boolean,
    }),
  ),
  remoteSha: Schema.String,
  publishedTree: Schema.String,
})

const PublishPullSchema = Schema.Struct({
  approvalId: Schema.String,
  threadId: Schema.optional(Schema.NullOr(Schema.String)),
  title: Schema.String,
  body: Schema.String,
  draft: Schema.Boolean,
  repos: Schema.Array(Schema.String),
  repo: Schema.optional(Schema.NullOr(Schema.String)),
  stackId: Schema.optional(Schema.NullOr(Schema.Finite)),
  layer: Schema.optional(Schema.NullOr(Schema.Finite)),
  stacks: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        layers: Schema.Array(StackLayerSchema),
        native: Schema.NullOr(
          Schema.Union([
            Schema.Struct({ number: Schema.Finite, url: Schema.String }),
            Schema.Struct({ error: Schema.String }),
          ]),
        ),
      }),
    ),
  ),
})

export function createPublishPullRequestEffect(env: ShuttleEnv, storage?: DurableObjectStorage) {
  return shuttleModule.effect({
    type: 'shuttle.publishPullRequest',
    placement: 'local',
    input: PublishPullSchema,
    execute: async (input, ctx) => {
      const binding = await readSandboxBinding(storage, ctx.runId)

      if (!binding) {
        return publishFailed(input.approvalId, 'Sandbox is not bound for this session')
      }

      const sandbox = sandboxStub(env, binding.sandboxName)

      const selected = input.repo
        ? binding.repos.filter((repo) => repo.name === input.repo || repo.fullName === input.repo)
        : input.repos.length > 0
          ? binding.repos.filter(
              (repo) => input.repos.includes(repo.name) || input.repos.includes(repo.fullName),
            )
          : binding.repos

      if (selected.length === 0) {
        return publishFailed(input.approvalId, 'No matching linked repositories to publish')
      }

      try {
        await sandbox.ensureRepos(binding.repos)
        await sandbox.ensureWorktree(ctx.runId)

        const github = githubMirror(env)
        const priorStacks: SessionStacks = { ...input.stacks }
        const nextStacks: Record<string, SessionRepoStack> = { ...priorStacks }
        const mirrored: { repo: LinkedSandboxRepo; result: MirroredStack }[] = []

        for (const repo of selected) {
          // The stamp describes the proposing repo; other repos publish their current stack.
          const stamped = repo.name === input.repo || repo.fullName === input.repo

          const result = await mirrorRepoStack(
            github,
            sandbox,
            ctx.runId,
            repo,
            {
              title: input.title,
              body: input.body,
              draft: input.draft,
              stackId: stamped ? (input.stackId ?? null) : null,
              layer: stamped ? (input.layer ?? null) : null,
            },
            priorStacks,
          )

          mirrored.push({ repo, result })
          nextStacks[stackKey(repo.name, result.stackId)] = result.stack
        }

        if (mirrored.every(({ result }) => result.layers.length === 0)) {
          const checked = selected
            .map((repo) => `/workspace/.wt/${ctx.runId}/${repo.name}`)
            .join(', ')

          return publishFailed(
            input.approvalId,
            `No file changes to publish in ${checked}. Edits under /workspace/repos are never published`,
          )
        }

        await writeSessionStacks(storage, ctx.runId, nextStacks)

        const pullsStub = loomsStub(env.LOOMS_RUN, pullsRunId(env, orgOfRun(ctx.runId)))

        for (const pull of mirrored.flatMap(({ result }) => result.layers)) {
          if (pull.outcome === 'unchanged') {
            continue
          }

          const signals = recordPublished({
            installationId: pull.installationId,
            fullName: pull.fullName,
            number: pull.number,
            title: pull.title,
            body: pull.body,
            url: pull.url,
            draft: pull.draft,
            author: { login: pull.authorLogin, avatarUrl: pull.authorAvatarUrl },
            headRef: pull.headRef,
            headSha: pull.headSha,
            baseRef: pull.baseRef,
            baseSha: pull.baseSha,
            additions: pull.additions,
            deletions: pull.deletions,
            updatedAt: pull.updatedAt,
            isFork: pull.isFork,
            runId: ctx.runId,
            ...(input.threadId ? { threadId: input.threadId } : {}),
          })

          await pullsStub.signal(Array.isArray(signals) ? signals : [signals])
        }

        return mirrored.flatMap(({ repo, result }) => {
          if (result.layers.length === 0) {
            return []
          }

          return [
            shuttleModule.input('pr.published', {
              approvalId: input.approvalId,
              threadId: input.threadId ?? null,
              pulls: result.layers.map((pull) => ({
                fullName: pull.fullName,
                number: pull.number,
                url: pull.url,
                draft: pull.draft,
                outcome: pull.outcome,
                layer: pull.layer,
              })),
              repo: repo.name,
              stackId: result.stackId,
              layers: result.stack.layers.map((layer) => ({
                layer: layer.layer,
                branch: layer.branch,
                parentBranch: layer.parentBranch,
                pull: layer.pull,
                remoteSha: layer.remoteSha,
                publishedTree: layer.publishedTree,
              })),
              ...(result.stack.native ? { stack: result.stack.native } : {}),
            }),
          ]
        })
      } catch (error) {
        return publishFailed(
          input.approvalId,
          error instanceof Error ? error.message : String(error),
        )
      }
    },
  })
}

/** Returned rather than emitted: `ctx.emit` events are live-only and never reach the session thread. */
function publishFailed(approvalId: string, error: string) {
  return [shuttleModule.input('pr.publish_failed', { approvalId, error })]
}

import { z } from 'zod'

import { defineTool } from '@swirls/looms/agent'
import { asJson } from '@swirls/looms/core'

import type { ShuttleEnv } from '../../env'
import type { StackStatus } from '../../sandbox/workspace'
import { readSandboxBinding, type SandboxBinding } from '../../session/bind-sandbox'
import { prepareSessionSandbox } from '../../session/handoff'
import { readSessionStacks } from '../../session/session-stacks'
import { stackKey, type SessionStacks } from '../../session/stack-state'

/** Compact view for the model: every stack, its layers, and the PR each one maps to. */
export function describeStacks(status: StackStatus, published: SessionStacks) {
  return {
    repo: status.repo,
    current: { stack: status.currentStack, layer: status.currentLayer },
    pendingFiles: status.pending
      ? (status.layers.find((layer) => layer.layer === status.currentLayer)?.files ?? [])
      : [],
    stacks: status.stacks.map((summary) => {
      const prior = published[stackKey(status.repo, summary.stack)]

      return {
        stack: summary.stack,
        kind: summary.layers.length > 1 ? 'stacked' : 'standalone',
        layers: summary.layers.map((layer) => {
          const pull = prior?.layers.find((entry) => entry.layer === layer.layer)?.pull
          return {
            layer: layer.layer,
            branch: layer.branch,
            base: layer.parentBranch,
            pull: pull ? { number: pull.number, url: pull.url } : null,
          }
        }),
      }
    }),
  }
}

export function createStackLayerTool(
  env: ShuttleEnv,
  runId: string,
  storage?: DurableObjectStorage,
) {
  return defineTool({
    name: 'stack_layer',
    description: [
      'Manage PR stacks in the session worktree. A repo can hold several independent stacks; each layer of a stack becomes one PR based on the layer below it.',
      '`status`: list every stack, its layers, and their PRs.',
      '`new`: add a layer on top of the current stack (a PR stacked on the current top).',
      '`new_stack`: start an independent stack from the default branch. Its first layer is a standalone PR that does not include any other stack’s changes.',
      '`checkout`: switch to `stack` + `layer` to edit it (seals pending edits and restacks upper layers).',
      'Never git branch, checkout, or rebase by hand.',
    ].join(' '),
    input: z.object({
      action: z.enum(['status', 'new', 'new_stack', 'checkout']),
      repo: z
        .string()
        .optional()
        .describe('Repo name or full name; defaults to the first linked repo'),
      stack: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Stack number for checkout; defaults to the current stack'),
      layer: z.number().int().positive().optional().describe('Layer number for checkout (1-based)'),
    }),
    handler: async (input) => {
      const action = input.action
      const repoArg = input.repo ?? null

      const binding: SandboxBinding = (await readSandboxBinding(storage, runId)) ?? {
        sandboxName: runId,
        repos: [],
      }

      const sandbox = await prepareSessionSandbox(env, storage, runId, binding)

      const repo =
        binding.repos.find((entry) => entry.name === repoArg || entry.fullName === repoArg) ??
        binding.repos[0]

      if (!repo) {
        return { error: 'No linked repositories in this session' }
      }

      const published = await readSessionStacks(storage, runId)

      switch (action) {
        case 'status': {
          const status = await sandbox.stackStatus(runId, repo.name, repo.defaultBranch)
          return asJson({ ok: true, ...describeStacks(status, published) })
        }

        case 'new': {
          const created = await sandbox.newLayer(runId, repo.name, repo.defaultBranch)

          return asJson({
            ok: true,
            ...created,
            message: `Started stack ${created.stack} layer ${created.layer} on ${created.branch}, stacked on ${created.parentBranch}. Edit files here, then call propose_pull_request.`,
          })
        }

        case 'new_stack': {
          const created = await sandbox.newStack(runId, repo.name, repo.defaultBranch)

          return asJson({
            ok: true,
            ...created,
            message: `Started independent stack ${created.stack} on ${created.branch} from ${created.parentBranch}. The worktree no longer contains other stacks' changes. Edit files here, then call propose_pull_request for a standalone PR.`,
          })
        }

        case 'checkout': {
          if (!input.layer) {
            return { error: 'checkout requires layer' }
          }

          const current = input.stack
            ? null
            : await sandbox.stackStatus(runId, repo.name, repo.defaultBranch)

          const address = {
            stack: input.stack ?? current?.currentStack ?? 1,
            layer: input.layer,
          }

          const status = await sandbox.checkoutLayer(runId, repo.name, address, repo.defaultBranch)

          return asJson({
            ok: true,
            ...describeStacks(status, published),
            message: `Checked out stack ${address.stack} layer ${address.layer}. Edits here restack the layers above it in this stack.`,
          })
        }

        default: {
          const exhaustive: never = action
          return { error: `Unknown action: ${exhaustive}` }
        }
      }
    },
  })
}

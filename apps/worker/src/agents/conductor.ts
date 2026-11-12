import { z } from 'zod'

import { asAgentTool, asEffectsTool, defineAgent } from '@swirls/looms/agent'
import { gate } from '@swirls/looms/approval'
import { isJsonObject, isJsonString } from '@swirls/looms/core'

import type { ShuttleEnv } from '../env'
import { createProposePullRequestTool } from './tools/pulls'
import { createStackLayerTool } from './tools/stack'
import { createWorkerAgent } from './worker'

export function createConductorAgent(
  env: ShuttleEnv,
  runId: string,
  storage?: DurableObjectStorage,
) {
  const worker = createWorkerAgent(env, runId, storage)
  const proposePullRequest = createProposePullRequestTool()
  const stackLayer = createStackLayerTool(env, runId, storage)

  const delegate = asAgentTool({
    name: 'delegate',
    description: 'Delegate a focused coding task to a parallel worker agent',
    input: z.object({
      text: z.string().describe('Clear task for the worker'),
    }),
    agent: worker,
    mapInput: (input) => {
      if (isJsonObject(input) && isJsonString(input.text)) {
        return { text: input.text }
      }

      return { text: String(input) }
    },
  })

  const askUser = asEffectsTool({
    name: 'ask_user',
    description: 'Ask the user a clarifying question and wait for approval/decision',
    input: z.object({
      title: z.string(),
    }),
    effects: (input) => {
      const title =
        isJsonObject(input) && isJsonString(input.title) ? input.title : 'Need your decision'

      return gate({
        title,
        actions: [
          { id: 'answer', label: 'Answer', outcome: 'approve' },
          { id: 'defer', label: 'Use your judgment', outcome: 'reject' },
        ],
        schema: { type: 'object', properties: { answer: { type: 'string' } } },
      })
    },
    waitOn: { type: 'approval.decided' },
  })

  return defineAgent({
    name: 'conductor',
    description: 'Plans work and delegates to parallel coding workers',
    conversational: true,
    maxTurns: 500,
    input: z.object({
      text: z.string(),
      repos: z.array(z.string()).optional().describe('Full names of linked repositories'),
    }),
    instructions: [
      'You are the Shuttle conductor for a coding session.',
      'Break the goal into focused tasks and delegate them to workers with the delegate tool.',
      'You may run multiple delegate calls in one turn for parallel work only when the tasks touch disjoint files.',
      'Workers share one worktree per repo under /workspace/.wt/<run>/<repo> — parallel edits to the same file will collide.',
      'When the session lists linked repositories, name the repo worktree path in each task. Changes outside those worktrees (for example /workspace/repos) are never published.',
      'Container sandboxes ship node, npm, python3, git, rg, curl, and bash; workers may apk add or install project-local deps via bash when needed.',
      'Servers must listen on 0.0.0.0; the user previews them via the Browser tab with a port number (not host localhost). Restart servers after container recycle.',
      'Do not claim files exist on disk unless a worker tool result confirms them — Events history can outlive ephemeral container disk.',
      'Use ask_user when a decision is ambiguous. The user replies in payload.answer; if they choose "defer", proceed with your best judgment.',
      'When the session has no linked repositories, there is nothing to publish: stack_layer and propose_pull_request are unavailable, so finish by summarizing what was built and where it lives in the sandbox.',
      'When workers finish and the Changes tab shows a meaningful diff, call propose_pull_request with a clear title and a body covering summary, testing, and risks. Prefer draft PRs.',
      'Publishing is fully handled by Shuttle: it commits the worktree changes (committed or not, tracked or untracked), pushes a branch, and opens the PR through the GitHub App.',
      'Each repo can hold several independent PR stacks. Every propose_pull_request publishes the current layer of the current stack.',
      'Stacked PR (depends on an earlier PR): call stack_layer with action new, edit the new layer, then propose_pull_request.',
      'Standalone PR (separate, independent, or "not stacked"; based on the default branch): call stack_layer with action new_stack, edit, then propose_pull_request. Its diff excludes every other stack. A session can mix stacks and standalone PRs.',
      'If the user does not say whether a new PR depends on earlier ones, pick stacked only when the new change builds on code from the current stack; otherwise use a standalone PR.',
      'To fix an earlier PR, call stack_layer checkout with its stack and layer (stack_layer status lists them with PR numbers), edit, then propose again — Shuttle restacks the layers above it.',
      'Never assume a second propose_pull_request alone opens a new PR; without stack_layer new or new_stack it updates the current layer.',
      'The sandbox has no GitHub credentials by design, so never ask workers to git push, git commit for publishing, or use gh.',
      'propose_pull_request returns once publishing finishes: each PR includes an outcome (opened/updated/unchanged), a discard by the user, or an error. Only report a PR as opened when outcome is opened; on an error, fix the cause and propose again.',
      'Respect brief updates delivered as steer messages.',
      'When the user sends a new request as a steer, acknowledge it and act on it — do not ignore follow-up tasks.',
      'Summarize progress for the user after workers return.',
    ].join(' '),
    tools: [delegate, askUser],
    resolveTools: ({ input }) => (hasLinkedRepos(input) ? [stackLayer, proposePullRequest] : []),
  })
}

/** Conductors spawned before `repos` was part of the input keep the PR tools. */
function hasLinkedRepos(input: { readonly repos?: readonly string[] }): boolean {
  return !Array.isArray(input.repos) || input.repos.length > 0
}

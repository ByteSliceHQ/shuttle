import { z } from 'zod'

import { asAgentTool, asEffectsTool, defineAgent } from '@swirls/looms/agent'
import { gate } from '@swirls/looms/approval'
import { isJsonObject, isJsonString } from '@swirls/looms/core'

import { resolveTeam, workspaceRunId } from '../config'
import type { ShuttleEnv } from '../env'
import { loomsStub } from '../looms-stub'
import { readSponsor } from '../session/sponsor'
import { DEFAULT_TEAM, frameTask, presetRoles, type DelegateMode, type Team } from '../team'
import { orgOfRun } from '../tenancy/run-id'
import { createProposePullRequestTool } from './tools/pulls'
import { createStackLayerTool } from './tools/stack'
import { createVendorMemberAgent } from './vendor-member'
import { createWorkerAgent } from './worker'

export function createConductorAgent(
  env: ShuttleEnv,
  runId: string,
  storage?: DurableObjectStorage,
) {
  const worker = createWorkerAgent(env, runId, storage)
  const proposePullRequest = createProposePullRequestTool()
  const stackLayer = createStackLayerTool(env, runId, storage)

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
      'Break the goal into focused tasks and delegate them with your delegate tools.',
      'Your team is whichever delegate tools you have this turn: delegate is a Shuttle worker, delegate_codex is Codex, delegate_claude is Claude Code, delegate_cursor is Cursor. The team can change between turns. Codex, Claude Code and Cursor are full coding agents that plan and run their own tools and remember their earlier tasks in this session, so give them a goal and the relevant context rather than step-by-step edits; prefer them for larger or open-ended work when they are on the team.',
      'If a delegate tool description states a role for this session, follow it.',
      'Every team member works in the same worktree, so the disjoint-files rule for parallel work applies across all of them.',
      'Cross-review: after a substantial change, if a different agent is on the team, send that agent a review of the change with mode "review". Pass real findings back to the agent that wrote the code, through its own delegate tool, to fix. Stop after two review rounds and report anything still open.',
      "When the user addresses an agent directly with @codex, @claude, @cursor or @worker, pass that request to that agent through its delegate tool, in the user's words, without re-planning it or splitting it up. If you have no delegate tool for that agent, it is not on the team: do not do the work another way or offer to wait. Tell the user to tick that agent under the team section of the agent picker below the message box, then send the message again.",
      'When you summarize, say which agent did what.',
      'You may run multiple delegate calls in one turn for parallel work only when the tasks touch disjoint files.',
      'Workers share one worktree per repo under /workspace/.wt/<run>/<repo> — parallel edits to the same file will collide.',
      'Name the session worktree path in each task, whether or not repositories are linked. Changes outside the session worktree (for example /workspace/repos, or a new folder under /workspace) are never shown, saved, shared or published.',
      'Container sandboxes ship node, npm, python3, git, rg, curl, and bash; workers may apk add or install project-local deps via bash when needed.',
      'Servers must listen on 0.0.0.0; the user previews them via the Browser tab with a port number (not host localhost). Restart servers after container recycle.',
      'Do not claim files exist on disk unless a worker tool result confirms them — Events history can outlive ephemeral container disk.',
      'Use ask_user when a decision is ambiguous. The user replies in payload.answer; if they choose "defer", proceed with your best judgment.',
      'When the session has no linked repositories, there is nothing to publish: stack_layer and propose_pull_request are unavailable, so finish by summarizing what was built and where it lives in the sandbox.',
      'When workers finish and the Changes tab shows a meaningful diff, call propose_pull_request with a clear title and a body covering summary, testing, and risks. Prefer draft PRs.',
      'Publishing is fully handled by Shuttle: it commits the worktree changes (committed or not, tracked or untracked), pushes a branch, and opens the PR through the GitHub App.',
      'Each repo can hold several independent PR stacks. Every propose_pull_request publishes the current layer of the current stack.',
      'A session starts on stack 1 layer 1, based on the default branch. For the first PR of a session call propose_pull_request directly, with no stack_layer call before it.',
      'stack_layer new and new_stack are only for a further PR, after the current layer has been proposed. Call them before the work for that PR is written, never after: both move the worktree to a new branch, and new_stack resets it to the default branch.',
      'Stacked PR (depends on an earlier PR): call stack_layer with action new, edit the new layer, then propose_pull_request.',
      'Another standalone PR (separate, independent, or "not stacked"; based on the default branch): call stack_layer with action new_stack, edit, then propose_pull_request. Its diff excludes every other stack. A session can mix stacks and standalone PRs.',
      'If files are missing from the worktree after a stack_layer call, they were not deleted: they are committed on the layer you left. Call stack_layer status to find it and stack_layer checkout to return to it instead of rebuilding.',
      'If the user does not say whether a new PR depends on earlier ones, pick stacked only when the new change builds on code from the current stack; otherwise use a standalone PR.',
      'To fix an earlier PR, call stack_layer checkout with its stack and layer (stack_layer status lists them with PR numbers), edit, then propose again — Shuttle restacks the layers above it.',
      'Never assume a second propose_pull_request alone opens a new PR; without stack_layer new or new_stack it updates the current layer.',
      'The sandbox has no GitHub credentials by design, so never ask workers to git push, git commit for publishing, or use gh.',
      'propose_pull_request returns once publishing finishes: each PR includes an outcome (opened/updated/unchanged), a discard by the user, or an error. Only report a PR as opened when outcome is opened; on an error, fix the cause and propose again.',
      'Respect brief updates delivered as steer messages.',
      'When the user sends a new request as a steer, acknowledge it and act on it — do not ignore follow-up tasks.',
      'Summarize progress for the user after workers return.',
    ].join(' '),
    tools: [askUser],
    // The team and the linked repositories decide which tools exist, and both can change
    // between turns: the developer edits the team from the agent picker mid-session.
    resolveTools: async ({ input }) => [
      ...delegateTools(await sessionTeam(env, runId, storage), { worker }),
      ...(hasLinkedRepos(input) ? [stackLayer, proposePullRequest] : []),
    ],
  })
}

/**
 * The session's team, limited to vendor agents that are actually connected. Without storage
 * (unit tests and definition listings) a session has only Shuttle's own workers.
 */
async function sessionTeam(
  env: ShuttleEnv,
  runId: string,
  storage: DurableObjectStorage | undefined,
) {
  if (!storage) {
    return DEFAULT_TEAM
  }

  const team = await resolveTeam(env, storage, runId)

  if (!team.codex && !team.claudeCode && !team.cursor) {
    return team
  }

  // Vendor agents run on the sign-in of the person the session is working for.
  const ownerId = await readSponsor(storage)

  const connected = new Set(
    ownerId
      ? (
          await loomsStub(env.LOOMS_RUN, workspaceRunId(env, orgOfRun(runId))).listCredentials(
            ownerId,
          )
        ).map((entry) => entry.harness)
      : [],
  )

  return {
    ...team,
    codex: team.codex && connected.has('codex'),
    claudeCode: team.claudeCode && connected.has('claude-code'),
    cursor: team.cursor && connected.has('cursor'),
  }
}

const delegateInput = z.object({
  text: z.string().describe('Clear, self-contained task for the agent'),
  mode: z
    .enum(['build', 'review', 'plan'])
    .optional()
    .describe(
      'build (default) changes code. review inspects the current changes without editing and reports findings. plan produces an implementation plan without editing.',
    ),
})

function taskInput(input: unknown) {
  if (isJsonObject(input) && isJsonString(input.text)) {
    const mode = isJsonString(input.mode) ? (input.mode as DelegateMode) : undefined

    return { text: frameTask(input.text, mode) }
  }

  return { text: String(input) }
}

/** One delegate tool per team member. A preset's role for an agent rides on its description. */
export function delegateTools(
  team: Team,
  agents: { worker: ReturnType<typeof createWorkerAgent> },
) {
  const roles = presetRoles(team.preset)
  const tools = []

  if (team.workers) {
    tools.push(
      asAgentTool({
        name: 'delegate',
        description:
          'Delegate a focused coding task to a Shuttle worker. Workers are fast and cheap, and good for small, well-specified edits.',
        input: delegateInput,
        agent: agents.worker,
        mapInput: taskInput,
      }),
    )
  }

  if (team.codex) {
    tools.push(
      asAgentTool({
        name: 'delegate_codex',
        description: [
          "Delegate a task to Codex, a full coding agent on the developer's own subscription. It plans and runs its own tools, and it remembers its earlier tasks in this session.",
          roles.codex,
        ]
          .filter(Boolean)
          .join(' '),
        input: delegateInput,
        agent: createVendorMemberAgent('codex'),
        mapInput: taskInput,
      }),
    )
  }

  if (team.claudeCode) {
    tools.push(
      asAgentTool({
        name: 'delegate_claude',
        description: [
          "Delegate a task to Claude Code, a full coding agent on the developer's own subscription. It plans and runs its own tools, and it remembers its earlier tasks in this session.",
          roles.claudeCode,
        ]
          .filter(Boolean)
          .join(' '),
        input: delegateInput,
        agent: createVendorMemberAgent('claude-code'),
        mapInput: taskInput,
      }),
    )
  }

  if (team.cursor) {
    tools.push(
      asAgentTool({
        name: 'delegate_cursor',
        description:
          "Delegate a task to Cursor, a full coding agent on the developer's own subscription. It plans and runs its own tools, and it remembers its earlier tasks in this session.",
        input: delegateInput,
        agent: createVendorMemberAgent('cursor'),
        mapInput: taskInput,
      }),
    )
  }

  return tools
}

/** Conductors spawned before `repos` was part of the input keep the PR tools. */
function hasLinkedRepos(input: { readonly repos?: readonly string[] }): boolean {
  return !Array.isArray(input.repos) || input.repos.length > 0
}

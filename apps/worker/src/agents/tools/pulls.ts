import { z } from 'zod'

import { asEffectsTool } from '@swirls/looms/agent'
import { invoke, isJsonObject, isJsonString, type JsonValue } from '@swirls/looms/core'

import type { JsonObjectBuilder } from '../../session/json-object'

function asStringArray(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.filter(isJsonString)
}

/**
 * Propose opening pull requests for the current worktree stack layer.
 * Invokes preparePrPublishGate (stackStatus → stamp stack + layer → approval.requested);
 * the session thread publishes only after the user approves.
 * `waitOn` cannot match the per-call approval id, which is safe while a session
 * holds at most one pending publish.
 */
export function createProposePullRequestTool() {
  return asEffectsTool({
    name: 'propose_pull_request',
    description:
      'Propose opening (or updating) a GitHub pull request for the current layer of the current stack. Call stack_layer new first for another PR on top of the current stack, or stack_layer new_stack for a standalone PR off the default branch. Shuttle commits, pushes, and opens/updates the PRs itself after the user approves. When the current layer already has a PR (stack_layer status lists its number), this pushes an update to that PR and the user is asked to approve an update of it, not a new PR: say so in your message, for example "I will push this to #13". Returns the opened/updated PRs (with outcome), a discard message if the user declined, or an error.',
    input: z.object({
      repos: z
        .array(z.string())
        .optional()
        .describe('Repo names or full names to include; defaults to all linked repos with changes'),
      repo: z.string().optional().describe('Primary repo for this stack layer'),
      title: z.string().describe('Pull request title'),
      body: z.string().describe('Pull request body (summary, testing, risks)'),
      draft: z.boolean().optional().describe('Prefer draft PRs (default true)'),
    }),
    effects: (input) => {
      const obj = isJsonObject(input) ? input : {}
      const title = isJsonString(obj.title) ? obj.title : 'Shuttle changes'
      const body = isJsonString(obj.body) ? obj.body : ''
      const draft = obj.draft !== false
      const repos = asStringArray(obj.repos)
      const repo = isJsonString(obj.repo) ? obj.repo : (repos[0] ?? '')
      const approvalId = `pr_publish_${crypto.randomUUID()}`

      const gateInput: JsonObjectBuilder = { approvalId, title, body, draft, repos }

      if (repo !== '') {
        gateInput.repo = repo
      }

      return [invoke('shuttle.preparePrPublishGate', gateInput, `prepare_pr_${approvalId}`)]
    },
    waitOn: {
      type: ['shuttle.pr.published', 'shuttle.pr.publish_failed', 'shuttle.pr.discarded'],
    },
  })
}

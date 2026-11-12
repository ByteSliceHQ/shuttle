import { z } from 'zod'

import { asAgentTool, defineAgent } from '@swirls/looms/agent'
import { isJsonObject, isJsonString } from '@swirls/looms/core'

import type { ShuttleEnv } from '../env'
import { createReadOnlySandboxTools } from '../tools/sandbox'
import { createReviewTools } from './tools/review'
import { createWorkerAgent } from './worker'

export function createReviewerAgent(
  env: ShuttleEnv,
  runId: string,
  storage?: DurableObjectStorage,
) {
  const worker = createWorkerAgent(env, runId, storage)
  const readTools = createReadOnlySandboxTools(env, runId, storage)
  const reviewTools = createReviewTools(env, runId, storage)

  const delegate = asAgentTool({
    name: 'delegate',
    description: 'Delegate investigation of a file group to a worker agent',
    input: z.object({
      text: z.string().describe('Focused investigation task'),
    }),
    agent: worker,
    mapInput: (input) => {
      if (isJsonObject(input) && isJsonString(input.text)) {
        return { text: input.text }
      }

      return { text: String(input) }
    },
  })

  return defineAgent({
    name: 'reviewer',
    description: 'Reviews a pull request and drafts inline comments',
    conversational: true,
    maxTurns: 200,
    input: z.object({
      text: z.string(),
      pull: z
        .object({
          fullName: z.string(),
          number: z.number(),
          headSha: z.string(),
        })
        .optional(),
    }),
    instructions: [
      "You are Shuttle's pull request reviewer.",
      'Call pr_context first with the pull fullName and number from your input.',
      'Investigate suspicious changes with read-only sandbox tools or delegate file groups to workers.',
      'Draft precise inline comments with draft_review_comment; only anchor to lines covered by the diff.',
      'When finished, call submit_review with a summary, verdict, and the drafted comments. The user must approve before anything is posted to GitHub.',
      'Prefer actionable comments with optional suggestions. Do not nitpick style unless it hides a bug.',
    ].join(' '),
    tools: [
      reviewTools.prContext,
      reviewTools.draftReviewComment,
      reviewTools.submitReview,
      delegate,
      readTools.readFile,
      readTools.grep,
      readTools.gitDiff,
    ],
  })
}

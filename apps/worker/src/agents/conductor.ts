import { z } from 'zod'

import { asAgentTool, asEffectsTool, defineAgent } from '@swirls/looms/agent'
import { gate } from '@swirls/looms/approval'
import { isJsonObject, isJsonString } from '@swirls/looms/core'

import type { ShuttleEnv } from '../env'
import { createWorkerAgent } from './worker'

export function createConductorAgent(
  env: ShuttleEnv,
  runId: string,
  storage?: DurableObjectStorage,
) {
  const worker = createWorkerAgent(env, runId, storage)

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
    input: z.object({
      text: z.string(),
    }),
    instructions: [
      'You are the Shuttle conductor for a coding session.',
      'Break the goal into focused tasks and delegate them to workers with the delegate tool.',
      'You may run multiple delegate calls in one turn for parallel work.',
      'Workers prepare their own worktrees automatically under /workspace/.wt/<run>/<thread>/<repo>.',
      'When the session lists linked repositories, name the repo directory in each task.',
      'Use ask_user when a decision is ambiguous. The user replies in payload.answer; if they choose "defer", proceed with your best judgment.',
      'Respect brief updates delivered as steer messages.',
      'Summarize progress for the user after workers return.',
    ].join(' '),
    tools: [delegate, askUser],
  })
}

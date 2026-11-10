import { z } from 'zod'

import { defineAgent } from '@swirls/looms/agent'

import type { ShuttleEnv } from '../env'
import { createHistoryTools } from '../tools/history'
import { createReadOnlySandboxTools } from '../tools/sandbox'

export function createNarratorAgent(
  env: ShuttleEnv,
  runId: string,
  storage?: DurableObjectStorage,
) {
  const history = createHistoryTools(env, runId)
  const sandbox = createReadOnlySandboxTools(env, runId, storage)

  return defineAgent({
    name: 'narrator',
    description: 'Answers user questions without interrupting workers',
    conversational: false,
    input: z.object({
      text: z.string(),
      sessionRunId: z.string().optional(),
      brief: z.string().optional(),
      workers: z.array(z.string()).optional(),
    }),
    instructions: [
      'You are the Shuttle narrator.',
      'Answer the user question about the session, workers, or code.',
      'Use history tools and read-only sandbox tools.',
      'Never modify files.',
      'Keep answers concise and cite what you observed.',
    ].join(' '),
    tools: [
      history.queryEvents,
      history.runTree,
      history.friction,
      sandbox.readFile,
      sandbox.grep,
      sandbox.gitDiff,
    ],
  })
}

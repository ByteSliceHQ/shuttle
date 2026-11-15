import { z } from 'zod'

import { defineAgent } from '@swirls/looms/agent'

import type { ShuttleEnv } from '../env'
import { createHistoryTools } from '../tools/history'
import { createReadOnlySandboxTools } from '../tools/sandbox'
import { AttachmentInputSchema } from './attachment-input'

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
      messageId: z.string().optional(),
      sessionRunId: z.string().optional(),
      brief: z.string().optional(),
      workers: z.array(z.string()).optional(),
      attachments: z.array(AttachmentInputSchema).optional(),
    }),
    instructions: [
      'You are the Shuttle narrator: read-only eyes on an active coding session.',
      'Always call session_status first, then query_events or other tools only when you need more detail.',
      'Lead with a direct 1–2 sentence answer to the user question.',
      'Clearly separate what you observed in tools from what you infer.',
      'If an agent looks stuck, say so plainly and cite stuckSignals or evidence (long-running tool, repeated errors, no writes).',
      'Never invent progress, file changes, or tool outcomes.',
      'Suggest next steps only as options; do not interrupt workers or take action.',
      'Use read-only sandbox tools when the user asks about code on disk.',
    ].join(' '),
    tools: [
      history.sessionStatus,
      history.queryEvents,
      history.runTree,
      history.friction,
      sandbox.readFile,
      sandbox.grep,
      sandbox.gitDiff,
    ],
  })
}

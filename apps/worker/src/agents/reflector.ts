import { z } from 'zod'

import { defineAgent, defineTool } from '@swirls/looms/agent'

import type { ShuttleEnv } from '../env'
import { loomsStub } from '../looms-stub'
import { createHistoryTools } from '../tools/history'

export function createReflectorAgent(env: ShuttleEnv, runId: string) {
  const history = createHistoryTools(env, runId)

  const proposeLesson = defineTool({
    name: 'propose_lesson',
    description: 'Propose one playbook lesson with evidence citations to the playbook run',
    input: z.object({
      text: z.string(),
      scope: z.string().default('session'),
      evidence: z.array(
        z.object({
          runId: z.string(),
          seq: z.number(),
        }),
      ),
      playbookRunId: z.string().optional(),
      sourceRunId: z.string().optional(),
    }),
    handler: async (input) => {
      const lessonId = `lesson_${crypto.randomUUID()}`
      const playbookId = input.playbookRunId ?? env.SHUTTLE_PLAYBOOK_RUN_ID ?? 'shuttle-playbook'
      const sourceRunId = input.sourceRunId ?? runId
      const stub = loomsStub(env.LOOMS_RUN, playbookId)

      await stub.signal([
        {
          type: 'reflect.lesson.proposed',
          payload: {
            lessonId,
            text: input.text,
            scope: input.scope,
            evidence: input.evidence,
            sourceRunId,
          },
        },
      ])

      return { lessonId, ok: true, playbookRunId: playbookId }
    },
  })

  return defineAgent({
    name: 'reflector',
    description: 'Mines session friction and proposes playbook lessons',
    conversational: false,
    input: z.object({
      text: z.string(),
      sessionRunId: z.string().optional(),
      playbookRunId: z.string().nullable().optional(),
    }),
    instructions: [
      'You are the Shuttle reflector.',
      'Inspect friction and corrections with the history tools.',
      'Propose exactly one concrete, reusable lesson.',
      'Cite evidence as {runId, seq} pairs.',
      'Call propose_lesson when ready. If there is no real friction, say so and finish without proposing.',
    ].join(' '),
    tools: [history.queryEvents, history.runTree, history.friction, proposeLesson],
  })
}

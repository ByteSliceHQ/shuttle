import { z } from 'zod'

import { defineAgent, defineTool } from '@swirls/looms/agent'

import { playbookRunId } from '../config'
import type { ShuttleEnv } from '../env'
import { loomsStub } from '../looms-stub'
import { mayShareLessons } from '../reflect/sharing'
import { orgOfRun, sessionOfReflection } from '../tenancy/run-id'
import { createHistoryTools } from '../tools/history'

export function createReflectorAgent(env: ShuttleEnv, runId: string) {
  // History belongs to the session this run reflects on.
  const sessionRunId = sessionOfReflection(runId)
  const history = createHistoryTools(env, sessionRunId)

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
      // A private session's lessons stay out of the playbook the whole organization reads.
      if (!(await mayShareLessons(env, sessionRunId))) {
        return {
          lessonId: null,
          ok: false,
          playbookRunId: null,
          reason: 'This session is private, so its lessons are not added to the shared playbook.',
        }
      }

      const lessonId = `lesson_${crypto.randomUUID()}`
      // Always the playbook of this run's own organization, whatever the model was told or says.
      const playbookId = playbookRunId(env, orgOfRun(runId))
      const sourceRunId = input.sourceRunId ?? sessionRunId
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

      return { lessonId, ok: true, playbookRunId: playbookId, reason: null }
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
      'Inspect friction and corrections with the history tools (they already target the session run).',
      'Prefer friction entries from corrections, stops, and tool failures.',
      'Propose exactly one concrete, reusable lesson.',
      'Cite evidence as {runId, seq} pairs from the session.',
      'Pass playbookRunId and sourceRunId from your input when calling propose_lesson.',
      'Call propose_lesson when ready. If there is no real friction, say so and finish without proposing.',
    ].join(' '),
    tools: [history.queryEvents, history.runTree, history.friction, proposeLesson],
  })
}

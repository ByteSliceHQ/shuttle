import { describe, expect, test } from 'bun:test'
import { setTimeout as sleep } from 'node:timers/promises'

import { z } from 'zod'

import { agent, defineAgent } from '@swirls/looms/agent'
import { approval } from '@swirls/looms/approval'
import { evaluator } from '@swirls/looms/evaluator'
import { createLooms } from '@swirls/looms/runtime'

import { intake } from '../agents/intake'
import { codingSession, say, shuttleSession, transcript, routing } from './module'

const TextInput = z.object({
  text: z.string().optional(),
  sessionRunId: z.string().optional(),
  playbookRunId: z.string().nullable().optional(),
  brief: z.string().optional(),
  workers: z.array(z.string()).optional(),
})

const stubConductor = defineAgent({
  name: 'conductor',
  input: TextInput,
  instructions: 'Conduct.',
  runTurn: ({ input }) => ({
    message: {
      role: 'assistant',
      content: `Conductor ready for ${input.text ?? 'goal'}`,
    },
    done: true,
    output: { ok: true },
  }),
})

const stubNarrator = defineAgent({
  name: 'narrator',
  input: TextInput,
  instructions: 'Narrate.',
  runTurn: () => ({
    message: { role: 'assistant', content: 'Worker 2 is editing src/math.ts' },
    done: true,
    output: { ok: true },
  }),
})

const stubWorker = defineAgent({
  name: 'worker',
  input: TextInput,
  instructions: 'Work.',
  runTurn: () => ({
    message: { role: 'assistant', content: 'Worker done' },
    done: true,
    output: { ok: true },
  }),
})

const stubReflector = defineAgent({
  name: 'reflector',
  input: TextInput,
  instructions: 'Reflect.',
  runTurn: () => ({
    message: { role: 'assistant', content: 'No lesson' },
    done: true,
    output: { ok: true },
  }),
})

describe('shuttle session routing', () => {
  test('routes a question to the narrator without requiring a model', async () => {
    const looms = createLooms({
      modules: [
        agent({ definitions: [stubConductor, stubNarrator, stubWorker, stubReflector] }),
        evaluator({ definitions: [intake] }),
        approval(),
        shuttleSession({ definitions: [codingSession] }),
      ],
    })

    try {
      const { runId } = await looms.start(codingSession, {
        goal: 'Improve greet()',
        lessons: [],
        playbookVersion: 0,
      })

      await looms.signal(runId, [say({ messageId: 'm1', text: 'What is the conductor doing?' })])

      let chips = (await looms.project(runId, routing)).chips

      for (let i = 0; i < 50 && chips.length === 0; i++) {
        await sleep(20)
        chips = (await looms.project(runId, routing)).chips
      }

      expect(chips[0]?.kind).toBe('question')
      expect(chips[0]?.summary).toContain('narrator')

      const messages = (await looms.project(runId, transcript)).messages
      expect(messages.some((message) => message.role === 'user')).toBe(true)
    } finally {
      await looms.stop()
    }
  })
})

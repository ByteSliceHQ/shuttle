import { describe, expect, test } from 'bun:test'
import { setTimeout as sleep } from 'node:timers/promises'

import { z } from 'zod'

import { agent, defineAgent, type LlmAdapter } from '@swirls/looms/agent'
import { approval } from '@swirls/looms/approval'
import { evaluator } from '@swirls/looms/evaluator'
import { createLooms } from '@swirls/looms/runtime'

import { intake } from '../agents/intake'
import { createStubThinkingLlm, getThinkingObserver } from '../llm'
import { fakeEnv } from '../testing/fake-env'
import { codingSession, shuttleSession } from './module'

const TextInput = z.object({
  text: z.string().optional(),
  sessionRunId: z.string().optional(),
  playbookRunId: z.string().nullable().optional(),
  brief: z.string().optional(),
  workers: z.array(z.string()).optional(),
})

const ThoughtPayload = z.object({ turn: z.number(), text: z.string() })

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (await predicate()) {
      return
    }

    await sleep(20)
  }

  throw new Error('timed out waiting for condition')
}

describe('thinking traces', () => {
  test('launch returns a run id before the first wake settles', async () => {
    const conductor = defineAgent({
      name: 'conductor',
      input: TextInput,
      instructions: 'Conduct.',
      conversational: true,
      runTurn: async () => {
        await sleep(250)
        return {
          message: { role: 'assistant', content: 'slow' },
          done: true,
        }
      },
    })

    const looms = createLooms({
      modules: [
        agent({ definitions: [conductor] }),
        evaluator({ definitions: [intake] }),
        approval(),
        shuttleSession({ definitions: [codingSession], env: fakeEnv() }),
      ],
    })

    try {
      const startedAt = Date.now()

      const { runId } = await looms.launch(codingSession, {
        goal: 'Launch fast',
        lessons: [],
        playbookVersion: 0,
      })

      const elapsed = Date.now() - startedAt

      expect(runId).toBeTruthy()
      expect(elapsed).toBeLessThan(200)
    } finally {
      await looms.stop()
    }
  })

  test('callLlm middleware emits thinking deltas and commits thought before agent.message', async () => {
    const conductor = defineAgent({
      name: 'conductor',
      input: TextInput,
      instructions: 'Conduct.',
      conversational: true,
    })

    const looms = createLooms({
      modules: [
        agent({
          definitions: [conductor],
          llm: createStubThinkingLlm(),
        }),
        evaluator({ definitions: [intake] }),
        approval(),
        shuttleSession({ definitions: [codingSession], env: fakeEnv() }),
      ],
    })

    try {
      const { runId } = await looms.launch(codingSession, {
        goal: 'Trace thinking',
        lessons: [],
        playbookVersion: 0,
      })

      await waitFor(async () =>
        (await looms.getEvents(runId)).some((event) => event.type === 'agent.message'),
      )

      const events = await looms.getEvents(runId)
      const thoughtIndex = events.findIndex((event) => event.type === 'shuttle.turn.thought')
      const messageIndex = events.findIndex((event) => event.type === 'agent.message')

      expect(thoughtIndex).toBeGreaterThanOrEqual(0)
      expect(messageIndex).toBeGreaterThan(thoughtIndex)

      const thought = ThoughtPayload.parse(events[thoughtIndex]?.payload)

      expect(thought.text).toContain('Considering how to respond')
    } finally {
      await looms.stop()
    }
  })

  test('tool-only turns still commit a thought before the empty agent.message', async () => {
    const toolOnlyLlm: LlmAdapter = {
      complete: async (args) => {
        const observer = args.signal ? getThinkingObserver(args.signal) : undefined
        observer?.reset()
        await observer?.onDelta('Choosing tools for the empty reply')
        observer?.onComplete('Choosing tools for the empty reply', 18)

        return {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [],
          },
          toolCalls: [],
          usage: { input: 1, output: 0 },
        }
      },
    }

    const conductor = defineAgent({
      name: 'conductor',
      input: TextInput,
      instructions: 'Conduct.',
      conversational: true,
    })

    const looms = createLooms({
      modules: [
        agent({
          definitions: [conductor],
          llm: toolOnlyLlm,
        }),
        evaluator({ definitions: [intake] }),
        approval(),
        shuttleSession({ definitions: [codingSession], env: fakeEnv() }),
      ],
    })

    try {
      const { runId } = await looms.launch(codingSession, {
        goal: 'Tool only',
        lessons: [],
        playbookVersion: 0,
      })

      await waitFor(async () =>
        (await looms.getEvents(runId)).some((event) => event.type === 'shuttle.turn.thought'),
      )

      const events = await looms.getEvents(runId)
      const thoughtIndex = events.findIndex((event) => event.type === 'shuttle.turn.thought')
      const messageIndex = events.findIndex((event) => event.type === 'agent.message')

      expect(thoughtIndex).toBeGreaterThanOrEqual(0)
      expect(messageIndex).toBeGreaterThan(thoughtIndex)

      expect(events[thoughtIndex]?.payload).toMatchObject({
        text: 'Choosing tools for the empty reply',
        durationMs: 18,
      })
    } finally {
      await looms.stop()
    }
  })
})

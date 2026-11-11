import { describe, expect, test } from 'bun:test'
import { setTimeout as sleep } from 'node:timers/promises'

import { z } from 'zod'

import { agent, defineAgent, type AgentDefinition, type Message } from '@swirls/looms/agent'
import { approval } from '@swirls/looms/approval'
import { evaluator } from '@swirls/looms/evaluator'
import { createLooms, type Looms } from '@swirls/looms/runtime'

import { intake } from '../agents/intake'
import { codingSession, say, shuttleSession, transcript, routing } from './module'

const TextInput = z.object({
  text: z.string().optional(),
  sessionRunId: z.string().optional(),
  playbookRunId: z.string().nullable().optional(),
  brief: z.string().optional(),
  workers: z.array(z.string()).optional(),
})

function lastUserText(messages: readonly Message[]): string {
  return messages.findLast((message) => message.role === 'user')?.content ?? ''
}

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

function createSessionLooms(conductor: AgentDefinition) {
  return createLooms({
    modules: [
      agent({ definitions: [conductor, stubNarrator, stubWorker, stubReflector] }),
      evaluator({ definitions: [intake] }),
      approval(),
      shuttleSession({ definitions: [codingSession] }),
    ],
  })
}

async function startCodingSession(
  looms: Looms,
  goal = 'Build a todo app',
): Promise<{ runId: string }> {
  return looms.launch(codingSession, {
    goal,
    lessons: [],
    playbookVersion: 0,
  })
}

function conductorSpawnedPayloads(events: readonly { type: string; payload: unknown }[]) {
  return events
    .filter((event) => event.type === 'shuttle.conductor.spawned')
    .map(
      (event) => event.payload as { childThreadId: string; generation?: number; reason?: string },
    )
}

describe('shuttle session routing', () => {
  test('routes a question to the narrator without requiring a model', async () => {
    const stubConductor = defineAgent({
      name: 'conductor',
      input: TextInput,
      instructions: 'Conduct.',
      conversational: true,
      runTurn: ({ input }) => ({
        message: {
          role: 'assistant',
          content: `Conductor ready for ${input.text ?? 'goal'}`,
        },
        done: true,
        output: { ok: true },
      }),
    })

    const looms = createSessionLooms(stubConductor)

    try {
      const { runId } = await startCodingSession(looms, 'Improve greet()')

      await looms.signal(runId, [say({ messageId: 'm1', text: 'What is the conductor doing?' })])

      await waitFor(async () => (await looms.project(runId, routing)).chips.length > 0)

      const chips = (await looms.project(runId, routing)).chips
      expect(chips[0]?.kind).toBe('question')
      expect(chips[0]?.summary).toContain('narrator')

      const messages = (await looms.project(runId, transcript)).messages
      expect(messages.some((message) => message.role === 'user')).toBe(true)
    } finally {
      await looms.stop()
    }
  })

  test('a follow-up task wakes an idle conversational conductor', async () => {
    const seen: string[] = []

    const stubConductor = defineAgent({
      name: 'conductor',
      input: TextInput,
      instructions: 'Conduct.',
      conversational: true,
      maxTurns: 500,
      runTurn: ({ messages, input }) => {
        const text = lastUserText(messages) || String(input.text ?? '')
        seen.push(text)

        return {
          message: { role: 'assistant', content: `ack: ${text.slice(0, 40)}` },
          done: true,
        }
      },
    })

    const looms = createSessionLooms(stubConductor)

    try {
      const { runId } = await startCodingSession(looms)

      await waitFor(() => seen.some((text) => text.includes('Build a todo app')))

      await looms.signal(runId, [
        say({ messageId: 'task-1', text: 'add dark mode', forceKind: 'task' }),
      ])

      await waitFor(() => seen.some((text) => text.includes('add dark mode')))

      const chips = (await looms.project(runId, routing)).chips

      expect(chips.some((chip) => chip.kind === 'task' && chip.summary.includes('steered'))).toBe(
        true,
      )
    } finally {
      await looms.stop()
    }
  })

  test('stop on the conductor abandons the turn but keeps it alive for the next task', async () => {
    const seen: string[] = []

    const stubConductor = defineAgent({
      name: 'conductor',
      input: TextInput,
      instructions: 'Conduct.',
      conversational: true,
      maxTurns: 500,
      runTurn: ({ messages, input }) => {
        const text = lastUserText(messages) || String(input.text ?? '')
        seen.push(text)

        return { message: { role: 'assistant', content: `ack: ${text.slice(0, 40)}` }, done: true }
      },
    })

    const looms = createSessionLooms(stubConductor)

    try {
      const { runId } = await startCodingSession(looms)

      await waitFor(() => seen.some((text) => text.includes('Build a todo app')))

      const spawns = conductorSpawnedPayloads(await looms.getEvents(runId))
      const conductorThreadId = spawns[0]?.childThreadId
      expect(conductorThreadId).toBeDefined()

      await looms.signal(runId, [say({ messageId: 'stop-1', text: 'stop', forceKind: 'stop' })])

      await waitFor(async () => {
        const chips = (await looms.project(runId, routing)).chips
        return chips.some((chip) => chip.kind === 'stop')
      })

      await looms.signal(runId, [
        say({ messageId: 'task-2', text: 'add dark mode', forceKind: 'task' }),
      ])

      await waitFor(() => seen.some((text) => text.includes('add dark mode')))

      const events = await looms.getEvents(runId)

      expect(
        events.some(
          (event) =>
            event.type === 'runtime.thread.cancelled' && event.threadId === conductorThreadId,
        ),
      ).toBe(false)

      expect(conductorSpawnedPayloads(events)).toHaveLength(1)
    } finally {
      await looms.stop()
    }
  })

  test('respawns the conductor after failure when a later task arrives', async () => {
    const seen: string[] = []
    let attempts = 0

    const stubConductor = defineAgent({
      name: 'conductor',
      input: TextInput,
      instructions: 'Conduct.',
      conversational: true,
      maxTurns: 500,
      runTurn: ({ messages, input }) => {
        attempts += 1
        const text = lastUserText(messages) || String(input.text ?? '')
        seen.push(text)

        if (attempts === 1) {
          throw new Error('conductor crashed')
        }

        return { message: { role: 'assistant', content: `ack: ${text.slice(0, 40)}` }, done: true }
      },
    })

    const looms = createSessionLooms(stubConductor)

    try {
      const { runId } = await startCodingSession(looms)

      await waitFor(async () => {
        const events = await looms.getEvents(runId)
        return events.some((event) => event.type === 'runtime.thread.failed')
      })

      await looms.signal(runId, [
        say({ messageId: 'task-3', text: 'add dark mode', forceKind: 'task' }),
      ])

      await waitFor(() => seen.some((text) => text.includes('add dark mode')))

      expect(attempts).toBeGreaterThanOrEqual(2)

      const restarts = conductorSpawnedPayloads(await looms.getEvents(runId))
      expect(restarts).toHaveLength(2)
      expect(restarts[1]).toMatchObject({ generation: 1, reason: 'failed' })
    } finally {
      await looms.stop()
    }
  })

  test('queues a task while the conductor is down and includes it in the respawn input', async () => {
    const spawnInputs: string[] = []
    let attempts = 0

    const stubConductor = defineAgent({
      name: 'conductor',
      input: TextInput,
      instructions: 'Conduct.',
      conversational: true,
      maxTurns: 500,
      runTurn: ({ input }) => {
        attempts += 1
        const text = String(input.text ?? '')
        spawnInputs.push(text)

        if (attempts === 1) {
          throw new Error('conductor crashed')
        }

        return { message: { role: 'assistant', content: 'ready again' }, done: true }
      },
    })

    const looms = createSessionLooms(stubConductor)

    try {
      const { runId } = await startCodingSession(looms)

      await waitFor(async () => {
        const events = await looms.getEvents(runId)
        return events.some((event) => event.type === 'runtime.thread.failed')
      })

      await looms.signal(runId, [
        say({ messageId: 'task-4', text: 'ship it on port 3001', forceKind: 'task' }),
      ])

      await waitFor(() =>
        spawnInputs.some(
          (text) => text.includes('ship it on port 3001') || text.includes('Queued user messages'),
        ),
      )

      expect(
        spawnInputs.some(
          (text) =>
            text.includes('ship it on port 3001') && text.includes('Previous conductor ended'),
        ),
      ).toBe(true)

      const restarts = conductorSpawnedPayloads(await looms.getEvents(runId))
      expect(restarts[1]).toMatchObject({ generation: 1, reason: 'failed' })
    } finally {
      await looms.stop()
    }
  })
})

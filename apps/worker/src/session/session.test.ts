import { describe, expect, test } from 'bun:test'
import { setTimeout as sleep } from 'node:timers/promises'

import { z } from 'zod'

import { agent, defineAgent, type AgentDefinition, type Message } from '@swirls/looms/agent'
import { approval } from '@swirls/looms/approval'
import { evaluator } from '@swirls/looms/evaluator'
import { createLooms, type Looms } from '@swirls/looms/runtime'

import { intake } from '../agents/intake'
import { fakeEnv } from '../testing/fake-env'
import { codingSession, say, shuttleSession, transcript, routing } from './module'
import { requestPullRequest } from './signals'
import { sponsorOfMessages } from './sponsor'

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
      shuttleSession({ definitions: [codingSession], env: fakeEnv() }),
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

  test('routes a mid-work question while the conductor turn is still in flight', async () => {
    let releaseTurn: (() => void) | undefined
    let turnStarted = false

    const stubConductor = defineAgent({
      name: 'conductor',
      input: TextInput,
      instructions: 'Conduct.',
      conversational: true,
      maxTurns: 500,
      runTurn: async ({ messages, input }) => {
        const text = lastUserText(messages) || String(input.text ?? '')

        if (text.includes('Build a todo app')) {
          turnStarted = true

          await new Promise<void>((resolve) => {
            releaseTurn = resolve
          })
        }

        return {
          message: { role: 'assistant', content: `ack: ${text.slice(0, 40)}` },
          done: true,
        }
      },
    })

    const looms = createSessionLooms(stubConductor)

    try {
      const { runId } = await startCodingSession(looms)

      await waitFor(() => turnStarted)
      expect(releaseTurn).toBeDefined()

      // Do not await: signal joins the in-flight wake and would otherwise wait on the
      // blocked conductor turn. Non-blocking wake should still plan intake mid-flight.
      void looms
        .signal(runId, [say({ messageId: 'q-mid', text: 'still there?' })])
        .catch(() => undefined)

      // Intake + route must finish before the blocked conductor turn is released.
      await waitFor(async () => {
        const chips = (await looms.project(runId, routing)).chips
        return chips.some((chip) => chip.messageId === 'q-mid' && chip.kind === 'question')
      })

      expect(releaseTurn).toBeDefined()

      releaseTurn?.()
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

  test('initial screenshots reach the first conductor turn with their sandbox paths', async () => {
    const lines: { text: string; attachments: readonly { id: string }[] }[] = []

    const screenshot = {
      id: 'ast_0123456789abcdef0123456789abcdef',
      name: 'overflow.png',
      mediaType: 'image/png',
      size: 4096,
    }

    const conductor = defineAgent({
      name: 'conductor',
      input: TextInput.extend({
        attachments: z
          .array(
            z.object({ id: z.string(), name: z.string(), mediaType: z.string(), size: z.number() }),
          )
          .optional(),
      }),
      instructions: 'Conduct.',
      runTurn: ({ messages }) => {
        const last = messages.findLast((message) => message.role === 'user')
        lines.push({ text: last?.content ?? '', attachments: last?.attachments ?? [] })
        return { message: { role: 'assistant', content: 'ok' }, done: true }
      },
    })

    const looms = createSessionLooms(conductor)

    try {
      const { runId } = await looms.launch(codingSession, {
        goal: 'Fix this overflow',
        attachments: [screenshot],
      })

      await waitFor(() => lines.length > 0)
      expect(lines[0]?.attachments).toEqual([screenshot])

      expect(lines[0]?.text).toContain(
        `/workspace/.shuttle/${runId}/attachments/01234567-overflow.png`,
      )
    } finally {
      await looms.stop()
    }
  })

  test('a message keeps its attached files on the way to the conductor', async () => {
    const lines: { text: string; attachments: readonly { id: string }[] }[] = []

    const stubConductor = defineAgent({
      name: 'conductor',
      input: TextInput,
      instructions: 'Conduct.',
      conversational: true,
      maxTurns: 500,
      runTurn: ({ messages }) => {
        const last = messages.findLast((message) => message.role === 'user')

        lines.push({ text: last?.content ?? '', attachments: last?.attachments ?? [] })

        return { message: { role: 'assistant', content: 'ok' }, done: true }
      },
    })

    const looms = createSessionLooms(stubConductor)

    const screenshot = {
      id: 'ast_0123456789abcdef0123456789abcdef',
      name: 'overflow.png',
      mediaType: 'image/png',
      size: 4096,
    }

    try {
      const { runId } = await startCodingSession(looms)

      await waitFor(() => lines.length > 0)

      await looms.signal(runId, [
        say({
          messageId: 'task-files',
          text: 'fix this overflow',
          forceKind: 'task',
          attachments: [screenshot],
        }),
      ])

      await waitFor(() => lines.some((line) => line.text.includes('fix this overflow')))

      const line = lines.find((entry) => entry.text.includes('fix this overflow'))

      // The model is sent the file, and the text says where every agent can open it.
      expect(line?.attachments).toEqual([screenshot])

      expect(line?.text).toContain(
        `- overflow.png (image/png, 4 KB): /workspace/.shuttle/${runId}/attachments/01234567-overflow.png`,
      )
    } finally {
      await looms.stop()
    }
  })

  test('agents learn who a message is from once several people speak, and who the work is for', async () => {
    const turns: { text: string; sponsor: string | null }[] = []

    const stubConductor = defineAgent({
      name: 'conductor',
      input: TextInput,
      instructions: 'Conduct.',
      conversational: true,
      maxTurns: 500,
      runTurn: ({ messages, input }) => {
        const text = lastUserText(messages) || String(input.text ?? '')
        turns.push({ text, sponsor: sponsorOfMessages(messages) })

        return { message: { role: 'assistant', content: 'ok' }, done: true }
      },
    })

    const looms = createSessionLooms(stubConductor)
    const alice = { id: 'alice', name: 'Alice' }
    const bob = { id: 'bob', name: 'Bob' }
    const turnFor = (text: string) => turns.find((turn) => turn.text.includes(text))

    try {
      const { runId } = await looms.launch(codingSession, {
        goal: 'Build a todo app',
        lessons: [],
        playbookVersion: 0,
        ownerId: 'alice',
      })

      await waitFor(() => turnFor('Build a todo app') !== undefined)

      // The first turn is the goal: nobody has asked for anything by name yet.
      expect(turnFor('Build a todo app')?.sponsor).toBeNull()

      await looms.signal(runId, [
        say({ messageId: 't1', text: 'add dark mode', forceKind: 'task', author: alice }),
      ])

      await waitFor(() => turnFor('add dark mode') !== undefined)

      // Only the owner has spoken, so the message reads as before, and the work is hers.
      expect(turnFor('add dark mode')).toEqual({ text: 'add dark mode', sponsor: 'alice' })

      await looms.signal(runId, [
        say({ messageId: 't2', text: 'add a footer', forceKind: 'task', author: bob }),
      ])

      await waitFor(() => turnFor('add a footer') !== undefined)

      // A second person joined: the agent is told who is speaking, and now works for him.
      expect(turnFor('add a footer')).toEqual({ text: 'Bob: add a footer', sponsor: 'bob' })

      await looms.signal(runId, [
        say({
          messageId: 'i1',
          text: 'keep it accessible',
          forceKind: 'constraint',
          author: alice,
        }),
      ])

      await waitFor(() => turnFor('keep it accessible') !== undefined)

      // A constraint changes the brief, not who the work is for.
      expect(turnFor('keep it accessible')).toEqual({
        text: 'Brief v2: Alice: keep it accessible',
        sponsor: 'bob',
      })
    } finally {
      await looms.stop()
    }
  })

  test('heuristic stop bypasses intake and stops quickly', async () => {
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

      const before = await looms.getEvents(runId)
      const intakeBefore = before.filter((event) => event.type === 'shuttle.intake.started').length

      await looms.signal(runId, [say({ messageId: 'stop-heuristic', text: 'stop now' })])

      await waitFor(async () => {
        const chips = (await looms.project(runId, routing)).chips
        return chips.some((chip) => chip.kind === 'stop')
      })

      const after = await looms.getEvents(runId)

      expect(after.some((event) => event.type === 'shuttle.intake.bypassed')).toBe(true)

      expect(after.filter((event) => event.type === 'shuttle.intake.started').length).toBe(
        intakeBefore,
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

function publishGates(events: readonly { type: string; payload: unknown }[]) {
  return events
    .filter((event) => event.type === 'approval.requested')
    .map((event) => event.payload as { approvalId: string; description: string })
    .filter((payload) => payload.approvalId.startsWith('pr_publish_'))
}

describe('the PR button', () => {
  const idleConductor = defineAgent({
    name: 'conductor',
    input: TextInput,
    instructions: 'Conduct.',
    conversational: true,
    runTurn: () => ({ message: { role: 'assistant', content: 'Ready' }, done: true }),
  })

  test('opens the publish card, titled from the goal when nothing is committed', async () => {
    const looms = createSessionLooms(idleConductor)

    try {
      const { runId } = await startCodingSession(looms, 'Support attachments in the first message')

      await looms.signal(runId, [
        requestPullRequest({ requestId: 'r1', title: '', body: '', draft: true }),
      ])

      await waitFor(async () => publishGates(await looms.getEvents(runId)).length > 0)

      const [gate] = publishGates(await looms.getEvents(runId))

      expect(gate?.approvalId).toBe('pr_publish_r1')
      expect(gate?.description).toBe('Support attachments in the first message')
    } finally {
      await looms.stop()
    }
  })

  test('asks once while a card is already open', async () => {
    const looms = createSessionLooms(idleConductor)

    try {
      const { runId } = await startCodingSession(looms)

      await looms.signal(runId, [
        requestPullRequest({ requestId: 'r1', title: 'First', body: '', draft: true }),
      ])

      await waitFor(async () => publishGates(await looms.getEvents(runId)).length > 0)

      await looms.signal(runId, [
        requestPullRequest({ requestId: 'r2', title: 'Second', body: '', draft: true }),
      ])

      await sleep(200)

      expect(publishGates(await looms.getEvents(runId)).map((gate) => gate.approvalId)).toEqual([
        'pr_publish_r1',
      ])
    } finally {
      await looms.stop()
    }
  })
})

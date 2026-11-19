import { describe, expect, test } from 'bun:test'
import { setTimeout as sleep } from 'node:timers/promises'

import { z } from 'zod'

import { agent, asAgentTool, asEffectsTool, defineAgent } from '@swirls/looms/agent'
import { approval, gate } from '@swirls/looms/approval'
import { emptyRunState, type EventEnvelope, type JsonValue } from '@swirls/looms/core'
import { evaluator } from '@swirls/looms/evaluator'
import { createLooms } from '@swirls/looms/runtime'

import { intake } from '../agents/intake'
import type { EngineEnv } from '../env'
import type { LoomsRunStub } from '../looms-stub'
import { codingSession, say, shuttleSession } from '../session/module'
import { fakeEnv } from '../testing/fake-env'
import { createWorkspaceActivityProjector } from './activity'
import {
  deriveActivityFromRunState,
  deriveSessionActivity,
  initialSessionActivityState,
  reduceSessionActivity,
} from './activity-state'

interface RecordedSignal {
  readonly type: string
  readonly payload: {
    readonly runId: string
    readonly activity: string
    readonly at: number
    readonly seq?: number
  }
  readonly idempotencyKey?: string
}

function createTestEnv(signals: RecordedSignal[]): EngineEnv {
  // SAFETY: the projector reaches the Looms run only through `signal`, which this answers; no
  // other method of the stub is called.
  const stub = {
    signal: async (events: RecordedSignal[]) => {
      signals.push(...events)

      return emptyRunState('shuttle-workspace')
    },
  } as LoomsRunStub

  return fakeEnv({
    SHUTTLE_WORKSPACE_RUN_ID: 'shuttle-workspace',
    LOOMS_RUN: { getByName: () => stub },
  })
}

function createMemoryStorage(): DurableObjectStorage {
  const store = new Map<string, JsonValue>()

  // SAFETY: a value is read back as the type it was stored under, and the projector uses only
  // `get` and `put`.
  return {
    get: async <T>(key: string) => store.get(key) as T | undefined,
    put: async (key: string, value: JsonValue) => {
      store.set(key, value)
    },
  } as DurableObjectStorage
}

/** A run event as the log holds it, with the fields these tests do not look at filled in. */
function envelope(
  fields: Pick<EventEnvelope, 'type' | 'seq' | 'ts' | 'payload'> & Partial<EventEnvelope>,
): EventEnvelope {
  return {
    id: `evt_${fields.seq}`,
    runId: 'session_abc',
    threadId: null,
    origin: { type: 'system' },
    ...fields,
  }
}

function launchedEvent(seq = 1, ts = 5): EventEnvelope {
  return envelope({
    type: 'runtime.run.started',
    seq,
    ts,
    payload: {
      rootThreadId: 'thr_session',
      launchedBy: {
        runId: 'shuttle-workspace',
        threadId: 'root',
        effectId: 'launch_session_abc',
        causationId: 'evt_1',
        causationSeq: 3,
      },
    },
  })
}

describe('workspace activity projector', () => {
  test('coalesces a batch and only reports runs the workspace launched', async () => {
    const signals: RecordedSignal[] = []
    const env = createTestEnv(signals)

    const self = createWorkspaceActivityProjector(env, 'shuttle-workspace')

    await self.project([
      envelope({
        type: 'agent.turn.started',
        seq: 1,
        ts: 10,
        payload: {},
      }),
    ])

    expect(signals).toHaveLength(0)

    const playbook = createWorkspaceActivityProjector(env, 'shuttle-playbook')

    await playbook.project([
      envelope({ type: 'runtime.run.started', seq: 1, ts: 5, payload: {} }),
      envelope({ type: 'agent.turn.started', seq: 2, ts: 10, payload: {} }),
    ])

    expect(signals).toHaveLength(0)

    const projector = createWorkspaceActivityProjector(env, 'session_abc')

    await projector.project([
      launchedEvent(0, 5),
      envelope({
        type: 'agent.turn.started',
        seq: 1,
        ts: 10,
        payload: {},
      }),
      envelope({
        type: 'approval.requested',
        seq: 2,
        ts: 20,
        payload: {},
      }),
    ])

    expect(signals).toHaveLength(1)
    expect(signals[0]?.type).toBe('workspace.session.activity')
    expect(signals[0]?.payload.activity).toBe('needs_input')
    expect(signals[0]?.idempotencyKey).toBe('activity:session_abc:2')
  })

  test('settles a conversational conductor to idle on agent.turn.settled and keeps parallel workers working', async () => {
    const signals: RecordedSignal[] = []
    const storage = createMemoryStorage()
    const env = createTestEnv(signals)

    const firstInstance = createWorkspaceActivityProjector(env, 'session_parallel', storage)

    await firstInstance.project([
      launchedEvent(1, 100),
      envelope({
        type: 'runtime.thread.started',
        seq: 2,
        ts: 101,
        threadId: 'thr_session',
        payload: { threadId: 'thr_session', kind: 'shuttle-session', definitionName: 'coding' },
      }),
      envelope({
        type: 'shuttle.conductor.spawned',
        seq: 3,
        ts: 102,
        threadId: 'thr_session',
        payload: { childThreadId: 'thr_conductor' },
      }),
      envelope({
        type: 'runtime.thread.started',
        seq: 4,
        ts: 103,
        threadId: 'thr_conductor',
        payload: { threadId: 'thr_conductor', kind: 'agent', definitionName: 'conductor' },
      }),
      envelope({
        type: 'runtime.wait.registered',
        seq: 5,
        ts: 104,
        threadId: 'thr_session',
        payload: { waitId: 'w_mail', tag: { kind: 'shuttle-mailbox' } },
      }),
      envelope({
        type: 'agent.turn.started',
        seq: 6,
        ts: 110,
        threadId: 'thr_conductor',
        payload: { turn: 1, messageCount: 1 },
      }),
      envelope({
        type: 'agent.tool_call.requested',
        seq: 7,
        ts: 115,
        threadId: 'thr_conductor',
        payload: { turn: 1, toolCall: { id: 'del_1', name: 'delegate', arguments: {} } },
      }),
      envelope({
        type: 'agent.tool_call.requested',
        seq: 8,
        ts: 116,
        threadId: 'thr_conductor',
        payload: { turn: 1, toolCall: { id: 'del_2', name: 'delegate', arguments: {} } },
      }),
      envelope({
        type: 'agent.turn.settled',
        seq: 9,
        ts: 117,
        threadId: 'thr_conductor',
        payload: { turn: 1 },
      }),
      envelope({
        type: 'agent.spawn.requested',
        seq: 10,
        ts: 118,
        threadId: 'thr_conductor',
        payload: { toolCallId: 'del_1', childThreadId: 'thr_worker_1' },
      }),
      envelope({
        type: 'agent.spawn.requested',
        seq: 11,
        ts: 119,
        threadId: 'thr_conductor',
        payload: { toolCallId: 'del_2', childThreadId: 'thr_worker_2' },
      }),
      envelope({
        type: 'runtime.thread.started',
        seq: 12,
        ts: 120,
        threadId: 'thr_worker_1',
        payload: { threadId: 'thr_worker_1', kind: 'agent', definitionName: 'worker' },
      }),
      envelope({
        type: 'runtime.thread.started',
        seq: 13,
        ts: 121,
        threadId: 'thr_worker_2',
        payload: { threadId: 'thr_worker_2', kind: 'agent', definitionName: 'worker' },
      }),
    ])

    expect(signals).toHaveLength(1)
    expect(signals[0]?.payload.activity).toBe('working')

    // Simulate DO hibernation: re-instantiate projector backed by the same storage.
    // Worker 1 finishes, but Worker 2 is still running -> must stay 'working' without false 'idle'!
    const wokenInstance = createWorkspaceActivityProjector(env, 'session_parallel', storage)

    await wokenInstance.project([
      envelope({
        type: 'runtime.thread.completed',
        seq: 14,
        ts: 150,
        threadId: 'thr_worker_1',
        payload: { threadId: 'thr_worker_1', output: { ok: true } },
      }),
      envelope({
        type: 'agent.tool.result',
        seq: 15,
        ts: 151,
        threadId: 'thr_conductor',
        payload: {
          turn: 1,
          toolCallId: 'del_1',
          name: 'delegate',
          result: { ok: true },
          error: null,
        },
      }),
    ])

    // Still working (within 60s heartbeat window), so no redundant signal emitted.
    expect(signals).toHaveLength(1)

    // Worker 2 finishes, conductor runs its summary turn, and settles without completing its thread.
    await wokenInstance.project([
      envelope({
        type: 'runtime.thread.completed',
        seq: 16,
        ts: 200,
        threadId: 'thr_worker_2',
        payload: { threadId: 'thr_worker_2', output: { ok: true } },
      }),
      envelope({
        type: 'agent.tool.result',
        seq: 17,
        ts: 201,
        threadId: 'thr_conductor',
        payload: {
          turn: 1,
          toolCallId: 'del_2',
          name: 'delegate',
          result: { ok: true },
          error: null,
        },
      }),
      envelope({
        type: 'agent.turn.started',
        seq: 18,
        ts: 210,
        threadId: 'thr_conductor',
        payload: { turn: 2, messageCount: 4 },
      }),
      envelope({
        type: 'agent.message',
        seq: 19,
        ts: 220,
        threadId: 'thr_conductor',
        payload: { turn: 2, message: { role: 'assistant', content: 'All done!' } },
      }),
      envelope({
        type: 'agent.turn.settled',
        seq: 20,
        ts: 225,
        threadId: 'thr_conductor',
        payload: { turn: 2 },
      }),
    ])

    expect(signals).toHaveLength(2)

    expect(signals[1]?.payload).toEqual({
      runId: 'session_parallel',
      activity: 'idle',
      at: 220,
      seq: 19,
    })
  })

  test('tracks real Looms session transitions across ask_user, crash error, and recovery', async () => {
    const TextInput = z.object({ text: z.string().optional() })
    let turnNumber = 0

    const workerAgent = defineAgent({
      name: 'worker',
      input: TextInput,
      instructions: 'Work.',
      runTurn: () => ({
        message: { role: 'assistant', content: 'worker complete' },
        done: true,
      }),
    })

    const delegate = asAgentTool({
      name: 'delegate',
      description: 'Delegate to worker',
      input: z.object({ text: z.string() }),
      agent: workerAgent,
    })

    const askUserInput = z.object({ title: z.string() })

    const askUser = asEffectsTool({
      name: 'ask_user',
      description: 'Ask the human',
      input: askUserInput,
      effects: (input) =>
        gate({
          approvalId: 'gate_1',
          title: askUserInput.safeParse(input).data?.title ?? 'Approve?',
          actions: [
            { id: 'approve', label: 'Approve', outcome: 'approve' },
            { id: 'reject', label: 'Reject', outcome: 'reject' },
          ],
        }),
      waitOn: { type: 'approval.decided' },
    })

    const conductor = defineAgent({
      name: 'conductor',
      conversational: true,
      maxTurns: 20,
      input: TextInput,
      instructions: 'Conduct.',
      tools: [delegate, askUser],
      runTurn: () => {
        turnNumber += 1

        if (turnNumber === 1) {
          return {
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'tc_ask', name: 'ask_user', arguments: { title: 'Ship it?' } }],
            },
            toolCalls: [{ id: 'tc_ask', name: 'ask_user', arguments: { title: 'Ship it?' } }],
          }
        }

        if (turnNumber === 2) {
          return {
            message: { role: 'assistant', content: 'Shipped after your answer.' },
            done: true,
          }
        }

        if (turnNumber === 3) {
          throw new Error('rate limit hit')
        }

        return {
          message: { role: 'assistant', content: 'Recovered cleanly.' },
          done: true,
        }
      },
    })

    const narrator = defineAgent({
      name: 'narrator',
      input: TextInput,
      instructions: 'Narrate.',
      runTurn: () => ({ message: { role: 'assistant', content: 'ok' }, done: true }),
    })

    const reflector = defineAgent({
      name: 'reflector',
      input: TextInput,
      instructions: 'Reflect.',
      runTurn: () => ({ message: { role: 'assistant', content: 'ok' }, done: true }),
    })

    const looms = createLooms({
      modules: [
        agent({ definitions: [conductor, workerAgent, narrator, reflector] }),
        evaluator({ definitions: [intake] }),
        approval(),
        shuttleSession({ definitions: [codingSession], env: fakeEnv() }),
      ],
    })

    const foldAll = async (runId: string) => {
      const events = await looms.getEvents(runId)
      const state = events.reduce(reduceSessionActivity, initialSessionActivityState)
      return deriveSessionActivity(state)
    }

    const waitUntilActivity = async (runId: string, expected: string) => {
      for (let i = 0; i < 80; i++) {
        if ((await foldAll(runId)) === expected) {
          return
        }

        await sleep(20)
      }

      throw new Error(`Expected activity "${expected}", got "${await foldAll(runId)}"`)
    }

    try {
      const { runId } = await looms.launch(codingSession, {
        goal: 'Add rate limiting',
        lessons: [],
        playbookVersion: 0,
      })

      // 1. Conductor pauses on ask_user -> 'needs_input'
      await waitUntilActivity(runId, 'needs_input')
      expect(deriveActivityFromRunState(await looms.getRun(runId))).toBe('needs_input')

      // 2. Developer approves -> Conductor finishes turn 2 -> settles to 'idle'
      await looms.signal(runId, [
        {
          type: 'approval.decided',
          payload: {
            approvalId: 'gate_1',
            actionId: 'approve',
            outcome: 'approve',
            payload: { answer: 'Yes' },
          },
        },
      ])

      await waitUntilActivity(runId, 'idle')
      expect(deriveActivityFromRunState(await looms.getRun(runId))).toBe('idle')

      // 3. Follow-up task crashes Conductor on turn 3 -> surfaces 'error'
      await looms.signal(runId, [
        say({ messageId: 'm_crash', text: 'do step 2', forceKind: 'task' }),
      ])

      await waitUntilActivity(runId, 'error')
      expect(deriveActivityFromRunState(await looms.getRun(runId))).toBe('error')

      // 4. Another message respawns Conductor (gen 1) and settles back to 'idle'
      await looms.signal(runId, [
        say({ messageId: 'm_recover', text: 'retry step 2', forceKind: 'task' }),
      ])

      await waitUntilActivity(runId, 'idle')
      expect(deriveActivityFromRunState(await looms.getRun(runId))).toBe('idle')
    } finally {
      await looms.stop()
    }
  })
})

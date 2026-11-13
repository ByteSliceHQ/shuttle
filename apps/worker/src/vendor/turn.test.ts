import { describe, expect, test } from 'bun:test'

import type { LlmCompleteArgs } from '@swirls/looms/agent'

import type { BridgeEvent, BridgeEventBody } from '../../bridge/protocol'
import type { CredentialPayload } from '../credentials/store'
import { bindStepObserver, bindThinkingObserver } from '../llm'
import type { AgentRunInput } from '../sandbox/agent-runs'
import { runVendorTurn, SANDBOX_INSTRUCTIONS, type VendorTurnDeps } from './turn'

function memoryStorage() {
  const values = new Map<string, unknown>()

  return {
    values,
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      values.set(key, value)
    },
  } as unknown as Pick<DurableObjectStorage, 'get' | 'put'> & { values: Map<string, unknown> }
}

/** A sandbox whose agent run plays back `pages` of events, one page per read. */
function fakeSandbox(pages: BridgeEventBody[][], collected: Record<string, string> = {}) {
  const started: AgentRunInput[] = []
  const stopped: string[] = []
  let seq = 0
  let cursor = 0
  let stopAfterRead = false

  const sandbox: VendorTurnDeps['sandbox'] = {
    startAgentRun: async (input) => {
      started.push(input)
      return { started: true }
    },
    readAgentEvents: async (_runKey, offset) => {
      const body = stopAfterRead
        ? [{ type: 'turn_done', status: 'interrupted', text: '' } as const]
        : (pages[cursor] ?? [])

      cursor += 1

      const events = body.map((event) => {
        seq += 1
        return { ...event, seq, at: seq } as BridgeEvent
      })

      return {
        events,
        offset: offset + events.length,
        done: events.some((event) => event.type === 'turn_done'),
      }
    },
    agentRunState: async () => ({ state: cursor > pages.length + 1 ? 'exited' : 'running' }),
    stopAgentRun: async (runKey) => {
      stopped.push(runKey)
      stopAfterRead = true
      return { ok: true }
    },
    collectAgentFiles: async () => ({ files: collected }),
  }

  return { sandbox, started, stopped }
}

function deps(
  sandbox: VendorTurnDeps['sandbox'],
  overrides: Partial<VendorTurnDeps> = {},
): VendorTurnDeps & { saved: CredentialPayload[] } {
  const saved: CredentialPayload[] = []

  return {
    harness: 'codex',
    runId: 'run 1',
    cwd: '/workspace/.wt/run 1/demo',
    sandbox,
    storage: memoryStorage(),
    credentials: {
      get: async () => ({ files: { '.codex/auth.json': 'b2xk' } }),
      put: async (_harness, payload) => {
        saved.push(payload)
      },
    },
    sleep: async () => {},
    newRunKey: () => 'key',
    saved,
    ...overrides,
  }
}

function args(overrides: Partial<LlmCompleteArgs> = {}): LlmCompleteArgs {
  return {
    instructions: 'You are the conductor.',
    messages: [
      { role: 'user', content: 'first task' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'Add a README' },
    ],
    tools: [],
    ...overrides,
  }
}

describe('runVendorTurn', () => {
  test('runs the latest user message and reports each thing the agent did, in order', async () => {
    const { sandbox, started } = fakeSandbox([
      [{ type: 'thread', vendorThreadId: 'thr_1', model: 'gpt-test' }],
      [],
      [
        { type: 'thought_delta', delta: 'Plan. ' },
        { type: 'thought', text: 'Plan.' },
        { type: 'text_delta', delta: 'Looking. ' },
        { type: 'message', text: 'Looking.' },
        { type: 'tool_started', id: 't1', kind: 'command', title: 'ls' },
        {
          type: 'tool_finished',
          id: 't1',
          kind: 'command',
          title: 'ls',
          status: 'completed',
          output: 'a.ts',
        },
        { type: 'tool_started', id: 't2', kind: 'web_search', title: 'tailwind docs' },
        {
          type: 'tool_finished',
          id: 't2',
          kind: 'web_search',
          title: 'tailwind docs',
          status: 'failed',
        },
        { type: 'text_delta', delta: 'Added the README.' },
        { type: 'message', text: 'Added the README.' },
        { type: 'usage', input: 100, output: 20 },
        { type: 'turn_done', status: 'completed', text: 'Added the README.' },
      ],
    ])

    const controller = new AbortController()
    const seen: string[] = []

    bindThinkingObserver(controller.signal, {
      reset: () => {},
      onDelta: (delta) => {
        seen.push(`thinking:${delta}`)
      },
      onComplete: () => {
        seen.push('thinking-complete')
      },
    })

    bindStepObserver(controller.signal, {
      onStep: (step) => {
        seen.push(JSON.stringify(step))
      },
    })

    const result = await runVendorTurn(
      deps(sandbox),
      args({
        signal: controller.signal,
        onTextDelta: (delta) => {
          seen.push(`text:${delta}`)
        },
      }),
    )

    // Only the last message is the turn's reply. Earlier ones are steps of their own.
    expect(result).toEqual({
      message: { role: 'assistant', content: 'Added the README.' },
      usage: { input: 100, output: 20 },
    })

    expect(started).toEqual([
      {
        runKey: 'run_1_key',
        mode: 'turn',
        request: {
          harness: 'codex',
          prompt: 'Add a README',
          cwd: '/workspace/.wt/run 1/demo',
          instructions: SANDBOX_INSTRUCTIONS,
        },
        files: { '.codex/auth.json': 'b2xk' },
      },
    ])

    expect(seen).toEqual([
      '{"type":"started","harness":"codex","label":"Codex","model":"gpt-test"}',
      'thinking:Plan. ',
      expect.stringMatching(/^\{"type":"thought","text":"Plan\.","durationMs":\d+\}$/),
      'text:Looking. ',
      '{"type":"message","text":"Looking."}',
      '{"type":"tool_started","toolCall":{"id":"t1","name":"bash","arguments":{"command":"ls"}}}',
      '{"type":"tool_finished","toolCallId":"t1","result":"a.ts"}',
      '{"type":"tool_started","toolCall":{"id":"t2","name":"web_search","arguments":{"query":"tailwind docs"}}}',
      '{"type":"tool_finished","toolCallId":"t2","result":"","error":"failed"}',
      'text:Added the README.',
    ])
  })

  test('a failed tool keeps its output and says how it ended, with paths inside the worktree', async () => {
    const controller = new AbortController()
    const seen: string[] = []

    bindStepObserver(controller.signal, {
      onStep: (step) => {
        if (step.type !== 'started') {
          seen.push(JSON.stringify(step))
        }
      },
    })

    const file = '/workspace/.wt/run 1/demo/src/a.ts'

    const { sandbox } = fakeSandbox([
      [
        { type: 'tool_started', id: 't3', kind: 'file_change', title: file },
        {
          type: 'tool_finished',
          id: 't3',
          kind: 'file_change',
          title: file,
          status: 'failed',
          output: 'no match',
          exitCode: 2,
        },
        { type: 'turn_done', status: 'completed', text: 'done' },
      ],
    ])

    await runVendorTurn(deps(sandbox), args({ signal: controller.signal }))

    expect(seen).toEqual([
      '{"type":"tool_started","toolCall":{"id":"t3","name":"edit_file","arguments":{"path":"src/a.ts"}}}',
      '{"type":"tool_finished","toolCallId":"t3","result":"no match","error":"exit code 2"}',
    ])
  })

  test('a stopped turn still records what the agent had said', async () => {
    const controller = new AbortController()
    const seen: string[] = []

    bindStepObserver(controller.signal, {
      onStep: (step) => {
        seen.push(step.type === 'message' ? step.text : step.type)
      },
    })

    const { sandbox } = fakeSandbox([[{ type: 'message', text: 'Half way there.' }], [], []])

    const pending = runVendorTurn(
      deps(sandbox, {
        sleep: async () => {
          controller.abort()
        },
      }),
      args({ signal: controller.signal }),
    )

    expect(pending).rejects.toThrow('Aborted')
    await pending.catch(() => {})
    expect(seen).toEqual(['started', 'Half way there.'])
  })

  test('the next turn continues the vendor conversation', async () => {
    const first = fakeSandbox([
      [
        { type: 'thread', vendorThreadId: 'thr_1' },
        { type: 'turn_done', status: 'completed', text: 'one' },
      ],
    ])

    const storage = memoryStorage()

    await runVendorTurn(deps(first.sandbox, { storage }), args())

    const second = fakeSandbox([[{ type: 'turn_done', status: 'completed', text: 'two' }]])

    await runVendorTurn(deps(second.sandbox, { storage, newRunKey: () => 'key2' }), args())

    expect(second.started[0]?.request).toMatchObject({ vendorThreadId: 'thr_1' })
    expect(second.started[0]?.runKey).toBe('run_1_key2')
  })

  test('the chosen model and effort go to the agent, and nothing is sent when none is chosen', async () => {
    const turn: BridgeEventBody[] = [{ type: 'turn_done', status: 'completed', text: 'ok' }]
    const chosen = fakeSandbox([turn])

    await runVendorTurn(
      deps(chosen.sandbox, { choice: { model: 'gpt-6-astra', effort: 'high' } }),
      args(),
    )

    expect(chosen.started[0]?.request).toMatchObject({ model: 'gpt-6-astra', effort: 'high' })

    const unset = fakeSandbox([turn])

    await runVendorTurn(deps(unset.sandbox, { choice: {} }), args())

    expect(unset.started[0]?.request).not.toHaveProperty('model')
    expect(unset.started[0]?.request).not.toHaveProperty('effort')
  })

  test('a restart mid-turn rejoins the run instead of starting a second agent', async () => {
    const storage = memoryStorage()

    const interrupted = fakeSandbox([[{ type: 'text_delta', delta: 'working' }]])

    interrupted.sandbox.agentRunState = async () => {
      throw new Error('durable object restarted')
    }

    expect(runVendorTurn(deps(interrupted.sandbox, { storage }), args())).rejects.toThrow(
      'restarted',
    )

    await Bun.sleep(10)

    const resumed = fakeSandbox([[{ type: 'turn_done', status: 'completed', text: 'finished' }]])
    const result = await runVendorTurn(deps(resumed.sandbox, { storage }), args())

    expect(resumed.started).toEqual([])
    expect(result.message.content).toBe('finished')
  })

  test('different agents keep separate vendor conversations', async () => {
    const storage = memoryStorage()

    const page: BridgeEventBody[][] = [
      [
        { type: 'thread', vendorThreadId: 'thr_conductor' },
        { type: 'turn_done', status: 'completed', text: 'x' },
      ],
    ]

    await runVendorTurn(deps(fakeSandbox(page).sandbox, { storage }), args())

    const narrator = fakeSandbox([[{ type: 'turn_done', status: 'completed', text: 'y' }]])

    await runVendorTurn(
      deps(narrator.sandbox, { storage }),
      args({ instructions: 'You are the narrator.' }),
    )

    expect(narrator.started[0]?.request).not.toHaveProperty('vendorThreadId')
  })

  test('a team member keeps one conversation across tasks from different threads', async () => {
    const storage = memoryStorage()

    const first = fakeSandbox([
      [
        { type: 'thread', vendorThreadId: 'thr_member' },
        { type: 'turn_done', status: 'completed', text: 'built' },
      ],
    ])

    await runVendorTurn(
      deps(first.sandbox, { storage, member: { threadId: 'task_1' } }),
      args({ instructions: 'You are Codex.' }),
    )

    const second = fakeSandbox([[{ type: 'turn_done', status: 'completed', text: 'fixed' }]])

    await runVendorTurn(
      deps(second.sandbox, { storage, member: { threadId: 'task_2' }, newRunKey: () => 'key2' }),
      args({ instructions: 'You are Codex.' }),
    )

    expect(second.started[0]?.request).toMatchObject({ vendorThreadId: 'thr_member' })
  })

  test('a second task for a busy member runs in a conversation of its own', async () => {
    const storage = memoryStorage()

    // task_1 is mid-turn on the member conversation.
    await storage.put('shuttle:vendor:codex:member', {
      vendorThreadId: 'thr_member',
      pending: { runKey: 'run_1_busy', offset: 0, owner: 'task_1' },
    })

    const parallel = fakeSandbox([
      [
        { type: 'thread', vendorThreadId: 'thr_side' },
        { type: 'turn_done', status: 'completed', text: 'side task done' },
      ],
    ])

    const result = await runVendorTurn(
      deps(parallel.sandbox, { storage, member: { threadId: 'task_2' } }),
      args(),
    )

    expect(result.message.content).toBe('side task done')
    expect(parallel.started[0]?.request).not.toHaveProperty('vendorThreadId')

    // The busy conversation is untouched, and still belongs to task_1.
    expect(storage.values.get('shuttle:vendor:codex:member')).toEqual({
      vendorThreadId: 'thr_member',
      pending: { runKey: 'run_1_busy', offset: 0, owner: 'task_1' },
    })
  })

  test('a member conversation left behind by a dead turn is taken over', async () => {
    const storage = memoryStorage()

    await storage.put('shuttle:vendor:codex:member', {
      vendorThreadId: 'thr_member',
      pending: { runKey: 'run_1_dead', offset: 0, owner: 'task_1' },
    })

    const next = fakeSandbox([[{ type: 'turn_done', status: 'completed', text: 'carried on' }]])

    next.sandbox.agentRunState = async (runKey) => ({
      state: runKey === 'run_1_dead' ? 'exited' : 'running',
    })

    await runVendorTurn(deps(next.sandbox, { storage, member: { threadId: 'task_2' } }), args())

    expect(next.started[0]?.request).toMatchObject({ vendorThreadId: 'thr_member' })
    expect(next.started[0]?.runKey).toBe('run_1_key')
  })

  test('a failed turn comes back as a message that says why and how to fix sign-in', async () => {
    const { sandbox } = fakeSandbox([
      [{ type: 'turn_done', status: 'failed', text: '', error: '401 Unauthorized' }],
    ])

    const result = await runVendorTurn(deps(sandbox), args())

    expect(result.message.content).toBe(
      'Codex could not finish this turn: 401 Unauthorized. Connect Codex under Connections, then send your message again.',
    )
  })

  test('an agent that dies without a final event ends the turn as failed', async () => {
    const { sandbox } = fakeSandbox([])
    const result = await runVendorTurn(deps(sandbox), args())

    expect(result.message.content).toContain('stopped without finishing')
  })

  test('stopping the turn interrupts the agent', async () => {
    const controller = new AbortController()
    const { sandbox, stopped } = fakeSandbox([[{ type: 'text_delta', delta: 'working' }], [], []])

    const pending = runVendorTurn(
      deps(sandbox, {
        sleep: async () => {
          controller.abort()
        },
      }),
      args({ signal: controller.signal }),
    )

    expect(pending).rejects.toThrow('Aborted')
    await pending.catch(() => {})
    expect(stopped).toEqual(['run_1_key'])
  })

  test('stores the sign-in again only when the agent refreshed it', async () => {
    const page: BridgeEventBody[][] = [[{ type: 'turn_done', status: 'completed', text: 'x' }]]

    const unchanged = deps(fakeSandbox(page, { '.codex/auth.json': 'b2xk' }).sandbox)

    await runVendorTurn(unchanged, args())
    expect(unchanged.saved).toEqual([])

    const refreshed = deps(fakeSandbox(page, { '.codex/auth.json': 'bmV3' }).sandbox)

    await runVendorTurn(refreshed, args())
    expect(refreshed.saved).toEqual([{ files: { '.codex/auth.json': 'bmV3' } }])
  })
})

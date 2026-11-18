import { describe, expect, test } from 'bun:test'

import type { LlmCompleteArgs } from '@swirls/looms/agent'

import type { BridgeEvent, BridgeEventBody } from '../../bridge/protocol'
import type { CredentialPayload } from '../credentials/store'
import { bindStepObserver, bindThinkingObserver } from '../llm'
import type { AgentRunInput } from '../sandbox/agent-runs'
import {
  describeProposalOutcome,
  PULL_REQUEST_INSTRUCTIONS,
  runVendorTurn,
  SANDBOX_INSTRUCTIONS,
  type VendorTurnDeps,
} from './turn'

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

/** A credential lookup that answers `payload` and never saves anything. */
function connected(payload: CredentialPayload | null): VendorTurnDeps['credentials'] {
  return { get: async () => payload, put: async () => {} }
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

  test('hands the agent every message sent while its last turn ran', async () => {
    const { sandbox, started } = fakeSandbox([
      [{ type: 'turn_done', status: 'completed', text: 'Done.' }],
    ])

    await runVendorTurn(
      deps(sandbox),
      args({
        messages: [
          { role: 'user', content: 'first task' },
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: 'Rewrite it in TypeScript' },
          { role: 'user', content: 'and add Vite' },
        ],
      }),
    )

    expect(started[0]?.request).toMatchObject({
      prompt: 'Rewrite it in TypeScript\n\nand add Vite',
    })
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

/** The vendor conversation a run asked its agent to continue, if it asked for one. */
function continuedConversation(run: ReturnType<typeof fakeSandbox>): string | undefined {
  return run.started[0]?.mode === 'turn' ? run.started[0].request.vendorThreadId : undefined
}

describe("runVendorTurn in a person's own sandbox", () => {
  const done: BridgeEventBody[][] = [
    [{ type: 'thread', vendorThreadId: 'thr_1' }],
    [
      { type: 'message', text: 'Done.' },
      { type: 'turn_done', status: 'completed', text: 'Done.' },
    ],
  ]

  test('the sign-in is neither placed before the turn nor read back after it', async () => {
    let collected = 0
    const { sandbox, started } = fakeSandbox(done, { '.codex/auth.json': 'cmVmcmVzaGVk' })

    const turn = deps(
      {
        ...sandbox,
        collectAgentFiles: async (paths) => {
          collected += 1
          return sandbox.collectAgentFiles(paths)
        },
      },
      // Connected is recorded with no secret in it.
      { signInStaysInSandbox: true, billedTo: 'alice', credentials: connected({}) },
    )

    await runVendorTurn(turn, args())

    expect(started).toHaveLength(1)
    expect(started[0]?.files).toBeUndefined()
    expect(collected).toBe(0)
    expect(turn.saved).toEqual([])
  })

  test('work for someone who has not connected the agent stops and says so', async () => {
    const { sandbox, started } = fakeSandbox(done)

    const result = await runVendorTurn(
      deps(sandbox, { signInStaysInSandbox: true, billedTo: 'bob', credentials: connected(null) }),
      args(),
    )

    expect(started).toEqual([])
    expect(result.message.content).toContain('not connected')
  })

  test('connected elsewhere but not signed in where the turn runs stops and says where', async () => {
    const { sandbox, started } = fakeSandbox(done)

    const result = await runVendorTurn(
      deps(sandbox, {
        signInStaysInSandbox: true,
        billedTo: 'alice',
        // Connected in the cloud, so the record exists, but this machine has no sign-in.
        credentials: connected({}),
        signInPresent: async () => false,
        onMachine: true,
      }),
      args(),
    )

    expect(started).toEqual([])
    expect(result.message.content).toContain('not signed in on this machine')
  })

  test('a sign-in present where the turn runs lets the turn start', async () => {
    const { sandbox, started } = fakeSandbox(done)

    await runVendorTurn(
      deps(sandbox, {
        signInStaysInSandbox: true,
        billedTo: 'alice',
        credentials: connected({}),
        signInPresent: async () => true,
        onMachine: true,
      }),
      args(),
    )

    expect(started).toHaveLength(1)
  })

  test('on a machine the sign-in file is what counts, with nothing recorded', async () => {
    const { sandbox, started } = fakeSandbox(done)

    await runVendorTurn(
      deps(sandbox, {
        signInStaysInSandbox: true,
        billedTo: 'alice',
        credentials: connected(null),
        signInPresent: async () => true,
        onMachine: true,
      }),
      args(),
    )

    expect(started).toHaveLength(1)
  })

  test('each person continues their own vendor conversation', async () => {
    const storage = memoryStorage()
    const forAlice = fakeSandbox(done)
    const forBob = fakeSandbox(done)
    const again = fakeSandbox(done)
    const own = { signInStaysInSandbox: true, credentials: connected({}), storage }

    await runVendorTurn(deps(forAlice.sandbox, { ...own, billedTo: 'alice' }), args())
    await runVendorTurn(deps(forBob.sandbox, { ...own, billedTo: 'bob' }), args())
    await runVendorTurn(deps(again.sandbox, { ...own, billedTo: 'alice' }), args())

    // Bob's sandbox has no record of the conversation Alice's agent started.
    expect(continuedConversation(forBob)).toBeUndefined()
    expect(continuedConversation(again)).toBe('thr_1')
  })
})

describe('pull requests from a vendor agent', () => {
  const proposeTool = {
    name: 'propose_pull_request',
  } as unknown as LlmCompleteArgs['tools'][number]

  const proposed: BridgeEventBody[][] = [
    [
      { type: 'message', text: 'Done. The PR is waiting for your approval.' },
      {
        type: 'pr_proposed',
        id: 'p1',
        title: 'Support attachments in the first message',
        body: 'Adds the picker.',
        draft: true,
      },
      {
        type: 'turn_done',
        status: 'completed',
        text: 'Done. The PR is waiting for your approval.',
      },
    ],
  ]

  test("the agent gets Shuttle's tool and its instructions where the session can publish", async () => {
    const { sandbox, started } = fakeSandbox([
      [{ type: 'turn_done', status: 'completed', text: 'ok' }],
    ])

    await runVendorTurn(deps(sandbox), args({ tools: [proposeTool] }))

    const request = started[0]?.mode === 'turn' ? started[0].request : undefined

    expect(request?.shuttleTools).toEqual({ proposePullRequest: true })
    expect(request?.instructions).toContain(PULL_REQUEST_INSTRUCTIONS)
  })

  test('without a repository to publish to, the agent gets neither', async () => {
    const { sandbox, started } = fakeSandbox([
      [{ type: 'turn_done', status: 'completed', text: 'ok' }],
    ])

    await runVendorTurn(deps(sandbox), args())

    const request = started[0]?.mode === 'turn' ? started[0].request : undefined

    expect(request?.shuttleTools).toBeUndefined()
    expect(request?.instructions).not.toContain('propose_pull_request')
  })

  test("a proposal becomes the conductor's own propose_pull_request call", async () => {
    const { sandbox } = fakeSandbox(proposed)
    const result = await runVendorTurn(deps(sandbox), args({ tools: [proposeTool] }))

    expect(result.message.content).toBe('Done. The PR is waiting for your approval.')

    expect(result.toolCalls).toEqual([
      {
        id: 'vendor_pr_p1',
        name: 'propose_pull_request',
        arguments: {
          title: 'Support attachments in the first message',
          body: 'Adds the picker.',
          draft: true,
        },
      },
    ])

    expect(result.message.toolCalls).toEqual(result.toolCalls)
  })

  test("a team member's proposal is not handed on: the conductor proposes for the team", async () => {
    const { sandbox } = fakeSandbox(proposed)

    const result = await runVendorTurn(
      deps(sandbox, { member: { threadId: 'member-1' } }),
      args({ tools: [proposeTool] }),
    )

    expect(result.toolCalls).toBeUndefined()
  })

  test('once published, the turn ends without the agent, and its next prompt says how it went', async () => {
    const storage = memoryStorage()
    const first = fakeSandbox(proposed)

    await runVendorTurn(deps(first.sandbox, { storage }), args({ tools: [proposeTool] }))

    const published = fakeSandbox([])

    const settled = await runVendorTurn(
      deps(published.sandbox, { storage }),
      args({
        tools: [proposeTool],
        messages: [
          { role: 'user', content: 'could you create a PR?' },
          {
            role: 'assistant',
            content: 'Done.',
            toolCalls: [{ id: 'vendor_pr_p1', name: 'propose_pull_request', arguments: {} }],
          },
          {
            role: 'tool',
            toolCallId: 'vendor_pr_p1',
            content: JSON.stringify({
              approvalId: 'pr_publish_1',
              pulls: [
                {
                  fullName: 'acme/app',
                  number: 12,
                  url: 'https://github.com/acme/app/pull/12',
                  draft: true,
                  outcome: 'opened',
                },
              ],
            }),
          },
        ],
      }),
    )

    expect(published.started).toEqual([])
    expect(settled.message.content).toBe('Opened acme/app#12: https://github.com/acme/app/pull/12')

    const next = fakeSandbox([[{ type: 'turn_done', status: 'completed', text: 'ok' }]])

    await runVendorTurn(
      deps(next.sandbox, { storage }),
      args({
        tools: [proposeTool],
        messages: [
          { role: 'assistant', content: 'Opened acme/app#12' },
          { role: 'user', content: 'Thanks, now add a test' },
        ],
      }),
    )

    const prompt = next.started[0]?.mode === 'turn' ? next.started[0].request.prompt : ''

    expect(prompt).toContain('acme/app#12')
    expect(prompt).toContain('Thanks, now add a test')

    // Said once: the turn after that does not repeat it.
    const after = fakeSandbox([[{ type: 'turn_done', status: 'completed', text: 'ok' }]])

    await runVendorTurn(
      deps(after.sandbox, { storage }),
      args({ messages: [{ role: 'user', content: 'And the docs' }] }),
    )

    const again = after.started[0]?.mode === 'turn' ? after.started[0].request.prompt : ''

    expect(again).toBe('And the docs')
  })

  test('says what became of a proposal that failed or was discarded', () => {
    expect(
      describeProposalOutcome(JSON.stringify({ approvalId: 'a', error: 'branch protected' }))
        .forPerson,
    ).toContain('branch protected')

    expect(
      describeProposalOutcome(JSON.stringify({ approvalId: 'a', message: 'The user discarded it' }))
        .forAgent,
    ).toContain('discarded')
  })
})

import { describe, expect, test } from 'bun:test'
import { setTimeout as sleep } from 'node:timers/promises'

import { z } from 'zod'

import { agent, defineAgent } from '@swirls/looms/agent'
import { approval, decision } from '@swirls/looms/approval'
import { evaluator } from '@swirls/looms/evaluator'
import { createLooms } from '@swirls/looms/runtime'

import { intake } from '../agents/intake'
import { createProposePullRequestTool } from '../agents/tools/pulls'
import { recordPublished } from '../pulls/signals'
import { fakeEnv } from '../testing/fake-env'
import { codingSession, shuttleSession } from './module'

const TextInput = z.object({
  text: z.string().optional(),
  sessionRunId: z.string().optional(),
  playbookRunId: z.string().nullable().optional(),
  brief: z.string().optional(),
  workers: z.array(z.string()).optional(),
})

const ApprovalPayload = z.object({ approvalId: z.string() })
const ChildThreadPayload = z.object({ childThreadId: z.string() })
const ToolResultPayload = z.object({ toolCallId: z.string().optional() })

const SessionPublishState = z.object({
  pendingPrPublish: z.object({ threadId: z.string().nullable() }).nullable().optional(),
})

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (await predicate()) {
      return
    }

    await sleep(20)
  }

  throw new Error('timed out waiting for condition')
}

const proposeCall = {
  id: 'call_propose',
  name: 'propose_pull_request',
  arguments: { title: 'Fix login', body: 'Fixes the redirect loop.', draft: true },
}

const coder = defineAgent({
  name: 'conductor',
  conversational: true,
  input: TextInput,
  instructions: 'Ship it.',
  tools: [createProposePullRequestTool()],
  runTurn: ({ turn }) =>
    turn === 1
      ? {
          message: { role: 'assistant', content: '', toolCalls: [proposeCall] },
          toolCalls: [proposeCall],
        }
      : { message: { role: 'assistant', content: 'Waiting on the publish result.' } },
})

const quiet = (name: string) =>
  defineAgent({
    name,
    input: TextInput,
    instructions: name,
    runTurn: () => ({ message: { role: 'assistant', content: '' }, done: true, output: {} }),
  })

describe('PR publish thread links', () => {
  test('the publish effect learns which agent thread proposed the PR', async () => {
    const looms = createLooms({
      modules: [
        agent({ definitions: [coder, quiet('narrator'), quiet('worker'), quiet('reflector')] }),
        evaluator({ definitions: [intake] }),
        approval(),
        shuttleSession({ definitions: [codingSession], env: fakeEnv() }),
      ],
    })

    try {
      const { runId } = await looms.launch(codingSession, {
        goal: 'Fix login',
        lessons: [],
        playbookVersion: 0,
      })

      const proposed = async () =>
        (await looms.getEvents(runId)).find((event) => event.type === 'shuttle.pr.proposed')

      await waitFor(async () => (await proposed()) !== undefined)

      const proposal = await proposed()

      const approvalId = ApprovalPayload.parse(proposal?.payload).approvalId

      const conductorThreadId = (await looms.getEvents(runId))
        .filter((event) => event.type === 'shuttle.conductor.spawned')
        .map((event) => ChildThreadPayload.parse(event.payload).childThreadId)[0]

      expect(conductorThreadId).toBeDefined()
      expect(proposal?.threadId).toBe(conductorThreadId)

      const pendingPublish = async () => {
        const run = await looms.getRun(runId)
        const root = run.rootThreadId ? run.threads[run.rootThreadId] : undefined
        return root === undefined
          ? undefined
          : SessionPublishState.parse(root.state).pendingPrPublish
      }

      await waitFor(async () => (await pendingPublish()) != null)
      expect((await pendingPublish())?.threadId).toBe(conductorThreadId)

      await looms.signal(runId, [
        decision({
          approvalId,
          choice: {
            actionId: 'draft',
            outcome: 'approve',
            payload: { title: 'Fix login', body: 'Fixes the redirect loop.', draft: true },
          },
        }),
      ])

      const settled = async () =>
        (await looms.getEvents(runId)).find(
          (event) =>
            event.type === 'shuttle.pr.publish_failed' || event.type === 'shuttle.pr.published',
        )

      await waitFor(async () => (await settled()) !== undefined)

      // Without a bound sandbox the effect fails fast; reaching it proves approval invokes publish.
      expect((await settled())?.payload).toMatchObject({
        approvalId,
        error: 'Sandbox is not bound for this session',
      })

      expect((await settled())?.ephemeral).toBeFalsy()
      await waitFor(async () => (await pendingPublish()) === null)

      const toolResult = async () =>
        (await looms.getEvents(runId)).find(
          (event) =>
            event.type === 'agent.tool.result' &&
            event.threadId === conductorThreadId &&
            ToolResultPayload.parse(event.payload).toolCallId === proposeCall.id,
        )

      await waitFor(async () => (await toolResult()) !== undefined)

      expect((await toolResult())?.payload).toMatchObject({
        error: 'Sandbox is not bound for this session',
      })
    } finally {
      await looms.stop()
    }
  })

  test('discarding the proposal settles the proposing tool call', async () => {
    const looms = createLooms({
      modules: [
        agent({ definitions: [coder, quiet('narrator'), quiet('worker'), quiet('reflector')] }),
        evaluator({ definitions: [intake] }),
        approval(),
        shuttleSession({ definitions: [codingSession], env: fakeEnv() }),
      ],
    })

    try {
      const { runId } = await looms.launch(codingSession, {
        goal: 'Fix login',
        lessons: [],
        playbookVersion: 0,
      })

      const proposed = async () =>
        (await looms.getEvents(runId)).find((event) => event.type === 'shuttle.pr.proposed')

      await waitFor(async () => (await proposed()) !== undefined)

      const approvalId = ApprovalPayload.parse((await proposed())?.payload).approvalId

      await looms.signal(runId, [
        decision({ approvalId, choice: { actionId: 'discard', outcome: 'reject' } }),
      ])

      const toolResult = async () =>
        (await looms.getEvents(runId)).find(
          (event) =>
            event.type === 'agent.tool.result' &&
            ToolResultPayload.parse(event.payload).toolCallId === proposeCall.id,
        )

      await waitFor(async () => (await toolResult()) !== undefined)

      expect((await toolResult())?.payload).toMatchObject({
        result: { approvalId },
        error: null,
      })
    } finally {
      await looms.stop()
    }
  })

  test('recordPublished links the PR to the session thread', () => {
    const signals = recordPublished({
      installationId: 1,
      fullName: 'acme/api',
      number: 7,
      title: 'Fix login',
      body: '',
      url: 'https://github.com/acme/api/pull/7',
      draft: true,
      author: { login: 'shuttle[bot]', avatarUrl: '' },
      headRef: 'shuttle/run_1/api',
      headSha: 'aaa',
      baseRef: 'main',
      baseSha: 'bbb',
      additions: 1,
      deletions: 0,
      updatedAt: 1,
      isFork: false,
      runId: 'run_1',
      threadId: 'thread_coder',
    })

    const linked = (Array.isArray(signals) ? signals : [signals]).find(
      (event) => event.type === 'pulls.pull.linked',
    )

    expect(linked?.payload).toEqual({
      fullName: 'acme/api',
      number: 7,
      runId: 'run_1',
      role: 'author',
      threadId: 'thread_coder',
    })
  })
})

import { describe, expect, test } from 'bun:test'
import { setTimeout as sleep } from 'node:timers/promises'

import { z } from 'zod'

import { agent, asEffectsTool, defineAgent, type AgentDefinition } from '@swirls/looms/agent'
import { approval, gate } from '@swirls/looms/approval'
import type { EventInput, JsonValue } from '@swirls/looms/core'
import { evaluator } from '@swirls/looms/evaluator'
import { createLooms, type Looms } from '@swirls/looms/runtime'

import { intake } from '../agents/intake'
import type { EngineEnv } from '../env'
import type { ApprovalPolicy } from '../ports/approvals'
import type { ShuttleHost } from '../ports/host'
import type { ActingFor } from '../ports/identity'
import { codingSession, shuttleSession } from '../session/module'
import { requestPullRequest } from '../session/signals'
import type { SessionAccess } from '../tenancy/access'
import { fakeEnv } from '../testing/fake-env'
import { workspace } from '../workspace/module'
import type { SessionOutcome } from './outcome'
import { answerHeadlessQuestion, headlessOutcome, startHeadlessSession } from './start'

const TextInput = z.object({ text: z.string().optional() })
const Discarded = z.object({ approvalId: z.string(), message: z.string() })

function stubAgent(name: string) {
  return defineAgent({
    name,
    input: TextInput,
    instructions: name,
    conversational: name === 'conductor',
    runTurn: () => ({
      message: { role: 'assistant', content: 'Done' },
      done: true,
      output: { ok: true },
    }),
  })
}

/**
 * A host with every run in one in-memory Looms: the workspace runs that list sessions and the
 * sessions they launch. `LOOMS_RUN` answers the calls a headless start, outcome and answer make.
 */
/** A conductor that asks one question before it does anything, and reports the answer. */
function askingConductor(): AgentDefinition {
  let turns = 0

  const askUser = asEffectsTool({
    name: 'ask_user',
    description: 'Ask the person',
    input: z.object({ title: z.string() }),
    effects: () =>
      gate({
        approvalId: 'ask_1',
        title: 'Which database?',
        actions: [
          { id: 'answer', label: 'Answer', outcome: 'approve' },
          { id: 'defer', label: 'Use your judgment', outcome: 'reject' },
        ],
      }),
    waitOn: { type: 'approval.decided' },
  })

  const ask = { id: 'tc_ask', name: 'ask_user', arguments: { title: 'Which database?' } }

  return defineAgent({
    name: 'conductor',
    input: TextInput,
    instructions: 'Conduct.',
    conversational: true,
    tools: [askUser],
    runTurn: ({ messages }) => {
      turns += 1

      if (turns === 1) {
        return { message: { role: 'assistant', content: '', toolCalls: [ask] }, toolCalls: [ask] }
      }

      return {
        message: { role: 'assistant', content: `Heard: ${messages.at(-1)?.content ?? ''}` },
        done: true,
      }
    },
  })
}

interface MemoryHostOptions {
  readonly approvals?: ApprovalPolicy
  readonly conductor?: AgentDefinition
}

function memoryHost({ approvals, conductor = stubAgent('conductor') }: MemoryHostOptions = {}) {
  const access = new Map<string, SessionAccess>()
  const started: Looms[] = []

  const looms = (): Looms => {
    const [running] = started

    if (running === undefined) {
      throw new Error('the run was reached before Looms started')
    }

    return running
  }

  const stubFor = (name: string) => ({
    getRun: () => looms().getRun(name),
    launch: async (args: { kind: string; definitionName: string; input?: JsonValue }) => {
      await looms().launchRun({ ...args, runId: name })
    },
    getAccess: async () => access.get(name) ?? null,
    setAccess: async (given: SessionAccess) => {
      access.set(name, given)
      return given
    },
    signal: (events: readonly EventInput[]) => looms().signal(name, events),
  })

  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: the namespace answers getByName, the only method the headless API calls on it, and each stub answers the calls that API makes to a run.
  const namespace = { getByName: stubFor } as unknown as EngineEnv['LOOMS_RUN']

  // A sandbox with the session's repositories in place and nothing committed.
  const sandbox = {
    ensureRepos: async () => ({ ok: true }),
    ensureWorktree: async () => ({ ok: true }),
    stackStatus: async (_runId: string, repo: string) => ({
      repo,
      currentStack: 1,
      currentLayer: 1,
      layers: [],
      stacks: [],
      pending: false,
    }),
  }

  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: the namespace answers getByName, and the sandbox the calls a pull request proposal makes to one.
  const sandboxes = { getByName: () => sandbox } as unknown as EngineEnv['SANDBOX']
  const env = fakeEnv({ LOOMS_RUN: namespace, SANDBOX: sandboxes })

  started.push(
    createLooms({
      modules: [
        agent({ definitions: [conductor, ...['narrator', 'worker', 'reflector'].map(stubAgent)] }),
        evaluator({ definitions: [intake] }),
        approval(),
        shuttleSession({ definitions: [codingSession], env, approvals }),
        workspace(),
      ],
    }),
  )

  const host: ShuttleHost = approvals === undefined ? { env } : { env, ports: { approvals } }

  return { host, access, looms: looms() }
}

async function outcomeWhen(
  host: ShuttleHost,
  runId: string,
  state: SessionOutcome['state'],
): Promise<SessionOutcome> {
  const deadline = Date.now() + 5_000
  let last: SessionOutcome | null = null

  while (Date.now() < deadline) {
    // A run that has not been launched yet cannot be read.
    last = await headlessOutcome(host, runId).catch(() => null)

    if (last !== null && last.state === state) {
      return last
    }

    await sleep(20)
  }

  throw new Error(`the session never reached ${state}; last seen ${JSON.stringify(last)}`)
}

const organization: ActingFor = { kind: 'organization', orgId: 'org1', service: 'build-host' }

const request = {
  acting: organization,
  brief: 'Fix the flaky checkout test',
  repositories: [
    { installationId: 42, fullName: 'acme/shop', defaultBranch: 'main', private: true },
  ],
  metadata: { threadId: 'thr_1', workItemId: 'WI-7' },
  idempotencyKey: 'thr_1',
} as const

describe('a headless session, from start to finished', () => {
  test('starts from a repository and a brief and reports completed', async () => {
    const { host, access, looms } = memoryHost()

    try {
      const { runId } = await startHeadlessSession(host, request)

      expect(runId).toBe('o-org1-session_thr_1')
      expect(access.get(runId)).toEqual({ ownerId: null, memberIds: [], visibility: 'public' })

      expect(await outcomeWhen(host, runId, 'completed')).toEqual({
        state: 'completed',
        pullRequests: [],
      })

      const run = await looms.getRun(runId)
      const session = run.rootThreadId === null ? undefined : run.threads[run.rootThreadId]

      expect(session?.kind).toBe('shuttle-session')

      expect(session?.state).toMatchObject({
        goal: 'Fix the flaky checkout test',
        folderId: null,
        hostMetadata: { threadId: 'thr_1', workItemId: 'WI-7' },
        repos: [{ fullName: 'acme/shop', installationId: 42 }],
      })
    } finally {
      await looms.stop()
    }
  })

  test('asking again with the same key finds the session it started', async () => {
    const { host, looms } = memoryHost()

    try {
      const first = await startHeadlessSession(host, request)

      await outcomeWhen(host, first.runId, 'completed')

      const again = await startHeadlessSession(host, request)

      expect(again.runId).toBe(first.runId)

      expect((await looms.listRuns()).filter((id) => id.includes('session_'))).toEqual([
        first.runId,
      ])
    } finally {
      await looms.stop()
    }
  })

  test('is blocked on a pull request proposal until the host decides it', async () => {
    const { host, looms } = memoryHost()

    try {
      const { runId } = await startHeadlessSession(host, request)

      await outcomeWhen(host, runId, 'completed')

      await looms.signal(runId, [
        requestPullRequest({ requestId: 'r1', title: 'Fix the test', body: '', draft: true }),
      ])

      const blocked = await outcomeWhen(host, runId, 'blocked')

      expect(blocked).toMatchObject({
        state: 'blocked',
        question: { approvalId: 'pr_publish_r1', kind: 'publish-pull-request', expiresAt: null },
      })

      await answerHeadlessQuestion(
        host,
        runId,
        'pr_publish_r1',
        { decision: 'reject' },
        organization,
      )

      expect(await outcomeWhen(host, runId, 'completed')).toEqual({
        state: 'completed',
        pullRequests: [],
      })
    } finally {
      await looms.stop()
    }
  })

  test("is blocked on an agent's question until the host answers it", async () => {
    const { host, looms } = memoryHost({ conductor: askingConductor() })

    try {
      const { runId } = await startHeadlessSession(host, request)

      expect(await outcomeWhen(host, runId, 'blocked')).toEqual({
        state: 'blocked',
        question: {
          approvalId: 'ask_1',
          title: 'Which database?',
          description: null,
          kind: 'question',
          expiresAt: null,
        },
        pullRequests: [],
      })

      await answerHeadlessQuestion(host, runId, 'ask_1', { text: 'Postgres' }, organization)

      expect((await outcomeWhen(host, runId, 'completed')).state).toBe('completed')

      const answered = (await looms.getEvents(runId)).find(
        (event) => event.type === 'approval.decided',
      )

      expect(answered).toMatchObject({
        origin: { type: 'external', actorId: 'service_build-host' },
        payload: { approvalId: 'ask_1', outcome: 'approve', payload: { answer: 'Postgres' } },
      })
    } finally {
      await looms.stop()
    }
  })

  test("an approval after the host's expiry publishes nothing", async () => {
    const { host, looms } = memoryHost({ approvals: { expiresAfterMs: () => 1 } })

    try {
      const { runId } = await startHeadlessSession(host, request)

      await outcomeWhen(host, runId, 'completed')

      await looms.signal(runId, [
        requestPullRequest({ requestId: 'r1', title: 'Fix the test', body: '', draft: true }),
      ])

      const blocked = await outcomeWhen(host, runId, 'blocked')

      expect(blocked.state === 'blocked' && blocked.question.expiresAt).toBeNumber()

      await sleep(10)

      await answerHeadlessQuestion(
        host,
        runId,
        'pr_publish_r1',
        { decision: 'approve' },
        organization,
      )

      await outcomeWhen(host, runId, 'completed')

      const events = await looms.getEvents(runId)

      expect(events.some((event) => event.type === 'shuttle.pr.published')).toBe(false)

      const discarded = Discarded.parse(
        events.find((event) => event.type === 'shuttle.pr.discarded')?.payload,
      )

      expect(discarded.approvalId).toBe('pr_publish_r1')
      expect(discarded.message).toContain('expired')
    } finally {
      await looms.stop()
    }
  })

  test("answering for another organization's session is refused", async () => {
    const { host, looms } = memoryHost()

    try {
      const { runId } = await startHeadlessSession(host, request)

      expect(
        answerHeadlessQuestion(host, runId, 'pr_publish_r1', null, {
          kind: 'organization',
          orgId: 'org2',
          service: 'build-host',
        }),
      ).rejects.toThrow('another organization')
    } finally {
      await looms.stop()
    }
  })
})

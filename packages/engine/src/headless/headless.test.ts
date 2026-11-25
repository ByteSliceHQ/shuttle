import { describe, expect, test } from 'bun:test'
import { setTimeout as sleep } from 'node:timers/promises'

import { z } from 'zod'

import { agent, asEffectsTool, defineAgent, type AgentDefinition } from '@swirls/looms/agent'
import { approval, gate } from '@swirls/looms/approval'
import { invoke, type EventInput, type JsonValue } from '@swirls/looms/core'
import { evaluator } from '@swirls/looms/evaluator'
import { createLooms, type Looms } from '@swirls/looms/runtime'

import { intake } from '../agents/intake'
import { createProposePullRequestTool } from '../agents/tools/pulls'
import type { EngineEnv } from '../env'
import type { ApprovalDecisionRequest, ApprovalPolicy, ApprovalVerdict } from '../ports/approvals'
import type { ShuttleHost } from '../ports/host'
import type { ActingFor } from '../ports/identity'
import { codingSession, shuttleSession } from '../session/module'
import { requestPullRequest } from '../session/signals'
import type { SessionAccess } from '../tenancy/access'
import { fakeEnv } from '../testing/fake-env'
import { workspace } from '../workspace/module'
import type { SessionOutcome } from './outcome'
import {
  answerHeadlessQuestion,
  headlessOutcome,
  headlessSessions,
  sendHeadlessMessage,
  startHeadlessSession,
  stopHeadlessSession,
} from './start'

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

/** A conductor that calls `tool` once, and is done when the call settles. */
function callingConductor(
  tool: ReturnType<typeof asEffectsTool>,
  name: string,
  args: { readonly [key: string]: JsonValue } = {},
): AgentDefinition {
  let turns = 0
  const call = { id: 'tc_1', name, arguments: args }

  return defineAgent({
    name: 'conductor',
    input: TextInput,
    instructions: 'Conduct.',
    conversational: true,
    tools: [tool],
    runTurn: () => {
      turns += 1

      return turns === 1
        ? { message: { role: 'assistant', content: '', toolCalls: [call] }, toolCalls: [call] }
        : { message: { role: 'assistant', content: 'Done' }, done: true }
    },
  })
}

const REVIEW = {
  approvalId: 'pr_review_1',
  // Not a repository of the session, so an approved review stops before it reaches GitHub.
  fullName: 'acme/elsewhere',
  number: 7,
  commitId: 'abc123',
  summary: 'Two small things',
  verdict: 'comment',
  comments: [{ path: 'a.ts', line: 3, side: 'RIGHT', body: 'Rename this' }],
} as const

/** A tool that asks to submit a review the way the reviewer's `submit_review` does. */
const submitReview = asEffectsTool({
  name: 'submit_review',
  description: 'Propose submitting the drafted review',
  input: z.object({}),
  effects: () => [
    ...gate({
      approvalId: REVIEW.approvalId,
      title: 'Submit pull request review?',
      description: REVIEW.summary,
      actions: [
        { id: 'submit', label: 'Submit review', outcome: 'approve' },
        { id: 'discard', label: 'Discard', outcome: 'reject' },
      ],
    }),
    invoke(
      'shuttle.decideReviewGate',
      { ...REVIEW, comments: REVIEW.comments.map((comment) => ({ ...comment })) },
      'decide_review_1',
    ),
  ],
  waitOn: { type: 'approval.decided' },
})

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

/** The run's events, once one of `type` is among them. */
async function eventsWhen(looms: Looms, runId: string, type: string) {
  const deadline = Date.now() + 5_000

  while (Date.now() < deadline) {
    const events = await looms.getEvents(runId)

    if (events.some((event) => event.type === type)) {
      return events
    }

    await sleep(20)
  }

  throw new Error(`the session never recorded ${type}`)
}

/** An approvals port that answers every gate with `verdict`, and keeps what it was asked. */
function decidingPolicy(verdict: () => ApprovalVerdict) {
  const asked: ApprovalDecisionRequest[] = []

  const approvals: ApprovalPolicy = {
    expiresAfterMs: () => null,
    decide: async (opened) => {
      asked.push(opened)

      return verdict()
    },
  }

  return { approvals, asked }
}

const proposePullRequest = requestPullRequest({
  requestId: 'r1',
  title: 'Fix the test',
  body: '',
  draft: true,
})

const otherOrganization: ActingFor = { kind: 'organization', orgId: 'org2', service: 'build-host' }

const organization: ActingFor = { kind: 'organization', orgId: 'org1', service: 'build-host' }

/** Why a call was refused. Fails when it was not. */
async function refusal(call: Promise<void>): Promise<string> {
  try {
    await call
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause)
  }

  throw new Error('expected the call to be refused')
}

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

  test('words do not decide a pull request proposal, and it stays open', async () => {
    const { host, looms } = memoryHost()

    try {
      const { runId } = await startHeadlessSession(host, request)

      await outcomeWhen(host, runId, 'completed')

      await looms.signal(runId, [
        requestPullRequest({ requestId: 'r1', title: 'Fix the test', body: '', draft: true }),
      ])

      await outcomeWhen(host, runId, 'blocked')

      expect(
        await refusal(
          answerHeadlessQuestion(host, runId, 'pr_publish_r1', { text: 'Not yet' }, organization),
        ),
      ).toContain('decided with { decision }')

      expect(
        await refusal(answerHeadlessQuestion(host, runId, 'pr_publish_r1', null, organization)),
      ).toContain('decided with { decision }')

      expect((await headlessOutcome(host, runId)).state).toBe('blocked')

      const events = await looms.getEvents(runId)

      expect(events.some((event) => event.type === 'approval.decided')).toBe(false)
    } finally {
      await looms.stop()
    }
  })

  test("a decision does not answer an agent's question", async () => {
    const { host, looms } = memoryHost({ conductor: askingConductor() })

    try {
      const { runId } = await startHeadlessSession(host, request)

      await outcomeWhen(host, runId, 'blocked')

      expect(
        await refusal(
          answerHeadlessQuestion(host, runId, 'ask_1', { decision: 'approve' }, organization),
        ),
      ).toContain('answered with { text }')

      expect((await headlessOutcome(host, runId)).state).toBe('blocked')
    } finally {
      await looms.stop()
    }
  })

  test('an answer to a question the session does not have open is refused', async () => {
    const { host, looms } = memoryHost()

    try {
      const { runId } = await startHeadlessSession(host, request)

      await outcomeWhen(host, runId, 'completed')

      expect(
        await refusal(
          answerHeadlessQuestion(host, runId, 'ask_9', { text: 'Postgres' }, organization),
        ),
      ).toContain('no open question')
    } finally {
      await looms.stop()
    }
  })

  test("a person's session is not answered by someone it is not shared with", async () => {
    const { host, looms } = memoryHost({ conductor: askingConductor() })

    const actor = { orgId: 'org1', role: 'member', email: '' } as const
    const ada: ActingFor = { kind: 'person', actor: { ...actor, userId: 'u1', name: 'Ada' } }
    const grace: ActingFor = { kind: 'person', actor: { ...actor, userId: 'u2', name: 'Grace' } }

    try {
      const { runId } = await startHeadlessSession(host, { ...request, acting: ada })

      await outcomeWhen(host, runId, 'blocked')

      expect(
        await refusal(answerHeadlessQuestion(host, runId, 'ask_1', { text: 'Postgres' }, grace)),
      ).toContain('private to someone else')

      expect(
        await refusal(
          answerHeadlessQuestion(host, runId, 'ask_1', { text: 'Postgres' }, organization),
        ),
      ).toContain('private to someone else')

      await answerHeadlessQuestion(host, runId, 'ask_1', { text: 'Postgres' }, ada)

      expect((await outcomeWhen(host, runId, 'completed')).state).toBe('completed')
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

describe("a gate the host's approvals port decides", () => {
  test('an approved proposal goes on to publish with no answer from the host', async () => {
    const { approvals, asked } = decidingPolicy(() => 'approve')
    const { host, looms } = memoryHost({ approvals })

    try {
      const { runId } = await startHeadlessSession(host, request)

      await outcomeWhen(host, runId, 'completed')
      await looms.signal(runId, [proposePullRequest])

      // The sandbox here has no commits and no GitHub behind it, so the publish that the approval
      // starts ends in `publish_failed`. That it ran at all is what the approval decides.
      const events = await eventsWhen(looms, runId, 'shuttle.pr.publish_failed')

      expect(asked).toHaveLength(1)

      expect(asked[0]).toMatchObject({
        kind: 'publish-pull-request',
        approvalId: 'pr_publish_r1',
        orgId: 'org1',
        ownerId: null,
        hostMetadata: { threadId: 'thr_1', workItemId: 'WI-7' },
        proposal: {
          title: 'Fix the test',
          draft: true,
          repositories: ['acme/shop'],
          baseBranch: 'main',
          stack: { id: 1, layer: 1, parentPullRequest: null, restacks: [] },
          existingPullRequest: null,
        },
      })

      const decisions = events.filter((event) => event.type === 'approval.decided')

      expect(decisions).toHaveLength(1)

      expect(decisions[0]).toMatchObject({
        origin: { type: 'external', actorId: 'host-policy' },
        payload: { approvalId: 'pr_publish_r1', actionId: 'approve', outcome: 'approve' },
      })

      expect(events.some((event) => event.type === 'approval.requested')).toBe(true)
      expect(events.some((event) => event.type === 'shuttle.pr.discarded')).toBe(false)
      expect((await headlessOutcome(host, runId)).state).not.toBe('blocked')
    } finally {
      await looms.stop()
    }
  })

  test('a rejected proposal publishes nothing, and the session says so', async () => {
    const { approvals } = decidingPolicy(() => 'reject')
    const { host, looms } = memoryHost({ approvals })

    try {
      const { runId } = await startHeadlessSession(host, request)

      await outcomeWhen(host, runId, 'completed')
      await looms.signal(runId, [proposePullRequest])

      const events = await eventsWhen(looms, runId, 'shuttle.pr.discarded')

      expect(events.find((event) => event.type === 'approval.decided')).toMatchObject({
        origin: { type: 'external', actorId: 'host-policy' },
        payload: { approvalId: 'pr_publish_r1', actionId: 'discard', outcome: 'reject' },
      })

      const discarded = Discarded.parse(
        events.find((event) => event.type === 'shuttle.pr.discarded')?.payload,
      )

      expect(discarded.approvalId).toBe('pr_publish_r1')
      expect(discarded.message).toContain("host's approval policy rejected")

      expect(events.some((event) => event.type.startsWith('shuttle.pr.publish'))).toBe(false)

      expect(await outcomeWhen(host, runId, 'completed')).toEqual({
        state: 'completed',
        pullRequests: [],
      })
    } finally {
      await looms.stop()
    }
  })

  test('an undecided proposal waits for the host, as one with no policy does', async () => {
    const { approvals, asked } = decidingPolicy(() => 'undecided')
    const { host, looms } = memoryHost({ approvals })

    try {
      const { runId } = await startHeadlessSession(host, request)

      await outcomeWhen(host, runId, 'completed')
      await looms.signal(runId, [proposePullRequest])

      expect(await outcomeWhen(host, runId, 'blocked')).toMatchObject({
        state: 'blocked',
        question: { approvalId: 'pr_publish_r1', kind: 'publish-pull-request', expiresAt: null },
      })

      expect(asked).toHaveLength(1)

      const events = await looms.getEvents(runId)

      expect(events.some((event) => event.type === 'approval.decided')).toBe(false)

      await answerHeadlessQuestion(
        host,
        runId,
        'pr_publish_r1',
        { decision: 'reject' },
        organization,
      )

      expect((await outcomeWhen(host, runId, 'completed')).state).toBe('completed')
      // Asked when the gate opened, and not again when someone answered it.
      expect(asked).toHaveLength(1)
    } finally {
      await looms.stop()
    }
  })

  test('a policy that throws leaves the proposal waiting, with its expiry', async () => {
    const { host, looms } = memoryHost({
      approvals: {
        expiresAfterMs: () => 60_000,
        decide: async () => {
          throw new Error('the policy service is down')
        },
      },
    })

    try {
      const { runId } = await startHeadlessSession(host, request)

      await outcomeWhen(host, runId, 'completed')
      await looms.signal(runId, [proposePullRequest])

      const blocked = await outcomeWhen(host, runId, 'blocked')

      expect(blocked).toMatchObject({
        state: 'blocked',
        question: { approvalId: 'pr_publish_r1', kind: 'publish-pull-request' },
      })

      expect(blocked.state === 'blocked' && blocked.question.expiresAt).toBeNumber()

      const events = await looms.getEvents(runId)

      expect(events.some((event) => event.type === 'approval.decided')).toBe(false)
    } finally {
      await looms.stop()
    }
  })
})

describe("a gate an agent opens, decided by the host's approvals port", () => {
  test("an agent's rejected proposal is discarded, and the agent goes on", async () => {
    const { approvals, asked } = decidingPolicy(() => 'reject')

    const { host, looms } = memoryHost({
      approvals,
      conductor: callingConductor(createProposePullRequestTool(), 'propose_pull_request', {
        title: 'Fix the test',
        body: '',
      }),
    })

    try {
      const { runId } = await startHeadlessSession(host, request)
      const events = await eventsWhen(looms, runId, 'shuttle.pr.discarded')

      expect(asked).toHaveLength(1)
      expect(asked[0]).toMatchObject({ kind: 'publish-pull-request', orgId: 'org1' })

      expect(events.find((event) => event.type === 'approval.decided')).toMatchObject({
        origin: { type: 'external', actorId: 'host-policy' },
        payload: { outcome: 'reject' },
      })

      // The proposal comes round again in the session's mailbox after it was decided, and is not
      // taken for a new one: the session ends up with nothing open.
      expect(await outcomeWhen(host, runId, 'completed')).toEqual({
        state: 'completed',
        pullRequests: [],
      })
    } finally {
      await looms.stop()
    }
  })

  test("an agent's approved proposal goes on to publish", async () => {
    const { approvals } = decidingPolicy(() => 'approve')

    const { host, looms } = memoryHost({
      approvals,
      conductor: callingConductor(createProposePullRequestTool(), 'propose_pull_request', {
        title: 'Fix the test',
        body: '',
      }),
    })

    try {
      const { runId } = await startHeadlessSession(host, request)
      const events = await eventsWhen(looms, runId, 'shuttle.pr.publish_failed')

      expect(events.some((event) => event.type === 'shuttle.pr.discarded')).toBe(false)
      expect((await outcomeWhen(host, runId, 'completed')).state).toBe('completed')
    } finally {
      await looms.stop()
    }
  })

  test('an approved review is submitted as the agent drafted it', async () => {
    const { approvals, asked } = decidingPolicy(() => 'approve')

    const { host, looms } = memoryHost({
      approvals,
      conductor: callingConductor(submitReview, 'submit_review'),
    })

    try {
      const { runId } = await startHeadlessSession(host, request)

      // The session takes the approval as the go-ahead and tries to send the review, which stops
      // at a repository this session does not have.
      const events = await eventsWhen(looms, runId, 'shuttle.review.submit_failed')

      expect(asked).toEqual([
        {
          kind: 'submit-review',
          approvalId: 'pr_review_1',
          orgId: 'org1',
          ownerId: null,
          hostMetadata: { threadId: 'thr_1', workItemId: 'WI-7' },
          proposal: {
            repository: 'acme/elsewhere',
            number: 7,
            verdict: 'comment',
            summary: 'Two small things',
            commentCount: 1,
          },
        },
      ])

      expect(events.find((event) => event.type === 'approval.decided')).toMatchObject({
        origin: { type: 'external', actorId: 'host-policy' },
        payload: {
          approvalId: 'pr_review_1',
          actionId: 'submit',
          outcome: 'approve',
          payload: { summary: 'Two small things', verdict: 'comment', number: 7 },
        },
      })

      expect((await outcomeWhen(host, runId, 'completed')).state).toBe('completed')
    } finally {
      await looms.stop()
    }
  })

  test('a rejected review is not submitted', async () => {
    const { approvals } = decidingPolicy(() => 'reject')

    const { host, looms } = memoryHost({
      approvals,
      conductor: callingConductor(submitReview, 'submit_review'),
    })

    try {
      const { runId } = await startHeadlessSession(host, request)
      const events = await eventsWhen(looms, runId, 'approval.decided')

      expect(events.find((event) => event.type === 'approval.decided')).toMatchObject({
        origin: { type: 'external', actorId: 'host-policy' },
        payload: { approvalId: 'pr_review_1', actionId: 'discard', outcome: 'reject' },
      })

      expect((await outcomeWhen(host, runId, 'completed')).state).toBe('completed')

      const after = await looms.getEvents(runId)

      expect(after.some((event) => event.type.startsWith('shuttle.review.'))).toBe(false)
    } finally {
      await looms.stop()
    }
  })

  test('an undecided review waits for the host', async () => {
    const { approvals } = decidingPolicy(() => 'undecided')

    const { host, looms } = memoryHost({
      approvals,
      conductor: callingConductor(submitReview, 'submit_review'),
    })

    try {
      const { runId } = await startHeadlessSession(host, request)

      expect(await outcomeWhen(host, runId, 'blocked')).toMatchObject({
        state: 'blocked',
        question: { approvalId: 'pr_review_1', kind: 'submit-review' },
      })
    } finally {
      await looms.stop()
    }
  })
})

describe('a message to a headless session', () => {
  test('is recorded as from whoever the host acts for, and the session takes it up', async () => {
    const { host, looms } = memoryHost()

    try {
      const { runId } = await startHeadlessSession(host, request)

      await outcomeWhen(host, runId, 'completed')

      const sent = await headlessSessions(host).message(
        runId,
        { text: 'Also fix the cart test', messageId: 'm1', kind: 'task' },
        organization,
      )

      expect(sent).toEqual({ messageId: 'm1' })

      const events = await eventsWhen(looms, runId, 'shuttle.routed')

      expect(events.find((event) => event.type === 'shuttle.user.said')).toMatchObject({
        origin: { type: 'external', actorId: 'service_build-host' },
        payload: {
          messageId: 'm1',
          text: 'Also fix the cart test',
          forceKind: 'task',
          author: { id: 'service_build-host', name: 'build-host' },
        },
      })

      // The same message again adds nothing.
      await sendHeadlessMessage(
        host,
        runId,
        { text: 'Also fix the cart test', messageId: 'm1' },
        organization,
      )

      const said = (await looms.getEvents(runId)).filter(
        (event) => event.type === 'shuttle.user.said',
      )

      expect(said).toHaveLength(1)
      expect((await outcomeWhen(host, runId, 'completed')).state).toBe('completed')
    } finally {
      await looms.stop()
    }
  })

  test('is given a message id when the host names none', async () => {
    const { host, looms } = memoryHost()

    try {
      const { runId } = await startHeadlessSession(host, request)

      await outcomeWhen(host, runId, 'completed')

      const { messageId } = await sendHeadlessMessage(host, runId, { text: 'Thanks' }, organization)

      expect(messageId).not.toBe('')
    } finally {
      await looms.stop()
    }
  })

  test('is refused with no text, from another organization, or for a session not shared', async () => {
    const { host, looms } = memoryHost()

    const actor = { orgId: 'org1', role: 'member', email: '' } as const
    const ada: ActingFor = { kind: 'person', actor: { ...actor, userId: 'u1', name: 'Ada' } }

    try {
      const { runId } = await startHeadlessSession(host, { ...request, acting: ada })

      await outcomeWhen(host, runId, 'completed')

      const send = async (text: string, acting: ActingFor) => {
        await sendHeadlessMessage(host, runId, { text }, acting)
      }

      expect(await refusal(send('  ', ada))).toContain('needs text')
      expect(await refusal(send('Hello', otherOrganization))).toContain('another organization')
      expect(await refusal(send('Hello', organization))).toContain('private to someone else')

      const events = await looms.getEvents(runId)

      expect(events.some((event) => event.type === 'shuttle.user.said')).toBe(false)
    } finally {
      await looms.stop()
    }
  })
})

describe('stopping a headless session', () => {
  test("stops the turn its agent is in, recorded as the host's doing", async () => {
    const { host, looms } = memoryHost({ conductor: askingConductor() })

    try {
      const { runId } = await startHeadlessSession(host, request)

      await outcomeWhen(host, runId, 'blocked')

      const { stopped } = await headlessSessions(host).stop(runId, organization)

      expect(stopped).toHaveLength(1)

      const stops = (await looms.getEvents(runId)).filter(
        (event) => event.type === 'agent.turn.stopped',
      )

      expect(stops).toHaveLength(1)

      expect(stops[0]).toMatchObject({
        threadId: stopped[0],
        origin: { type: 'external', actorId: 'service_build-host' },
      })
    } finally {
      await looms.stop()
    }
  })

  test('stops nothing in a session whose agents have finished', async () => {
    const { host, looms } = memoryHost()

    try {
      const { runId } = await startHeadlessSession(host, request)

      await outcomeWhen(host, runId, 'completed')

      const run = await looms.getRun(runId)

      const working = Object.values(run.threads).filter(
        (thread) => thread.kind === 'agent' && thread.status !== 'completed',
      )

      const { stopped } = await stopHeadlessSession(host, runId, organization)

      expect(stopped).toEqual(working.map((thread) => thread.threadId))

      expect(
        await refusal(stopHeadlessSession(host, runId, organization, 'thr_missing').then(() => {})),
      ).toContain('no agent at work')
    } finally {
      await looms.stop()
    }
  })

  test('is refused from another organization, or for a session not shared', async () => {
    const { host, looms } = memoryHost({ conductor: askingConductor() })

    const actor = { orgId: 'org1', role: 'member', email: '' } as const
    const ada: ActingFor = { kind: 'person', actor: { ...actor, userId: 'u1', name: 'Ada' } }

    try {
      const { runId } = await startHeadlessSession(host, { ...request, acting: ada })

      await outcomeWhen(host, runId, 'blocked')

      const stop = async (acting: ActingFor) => {
        await stopHeadlessSession(host, runId, acting)
      }

      expect(await refusal(stop(otherOrganization))).toContain('another organization')
      expect(await refusal(stop(organization))).toContain('private to someone else')

      const events = await looms.getEvents(runId)

      expect(events.some((event) => event.type === 'agent.turn.stopped')).toBe(false)
      expect((await headlessOutcome(host, runId)).state).toBe('blocked')
    } finally {
      await looms.stop()
    }
  })
})

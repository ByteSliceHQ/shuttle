import type { AnyEventEnvelope, ProjectionDefinition, ThreadNode } from '@swirls/looms/core'

import type { SessionFeed, ToolCallItem } from './session-feed'

export type SessionActivity = 'working' | 'needs_input' | 'idle' | 'error'

export type SessionIndicatorTone =
  | 'starting'
  | 'working'
  | 'needs_input'
  | 'ready'
  | 'failed'
  | 'idle'
  | 'completed'
  | 'cancelled'

export type ThreadActivityTone =
  | 'working'
  | 'delegating'
  | 'needs_input'
  | 'idle'
  | 'completed'
  | 'failed'
  | 'cancelled'

type OpenToolCallState = 'executing' | 'spawned_child' | 'awaiting_effects'

interface AgentThreadActivity {
  readonly kind: 'agent'
  readonly definitionName: string
  readonly lineCount: number
  readonly midCallLines: number
  readonly inTurn: boolean
  readonly needsLlmCall: boolean
  readonly deferWake: boolean
  readonly openToolCalls: Readonly<Record<string, OpenToolCallState>>
}

interface EvaluatorThreadActivity {
  readonly kind: 'evaluator'
  readonly definitionName: string
}

interface SessionCoordinatorActivity {
  readonly kind: 'shuttle-session'
  readonly definitionName: string
  readonly parkedOnMailbox: boolean
}

interface GenericThreadActivity {
  readonly kind: 'other'
  readonly definitionName: string
  readonly activeWaits: readonly string[]
}

type TrackedThreadActivity =
  | AgentThreadActivity
  | EvaluatorThreadActivity
  | SessionCoordinatorActivity
  | GenericThreadActivity

export interface SessionActivityState {
  readonly runStatus: 'running' | 'completed' | 'failed' | 'cancelled'
  readonly rootThreadId: string | null
  readonly conductorThreadId: string | null
  readonly bindingSandbox: boolean
  readonly queuedForConductor: boolean
  readonly sessionError: boolean
  readonly pendingUserMessages: readonly string[]
  readonly pendingApprovals: Readonly<Record<string, string>>
  readonly threads: Readonly<Record<string, TrackedThreadActivity>>
  readonly activity: SessionActivity
}

const DEFAULT_THREAD_ID = '__default__'

export const initialSessionActivityState: SessionActivityState = {
  runStatus: 'running',
  rootThreadId: null,
  conductorThreadId: null,
  bindingSandbox: false,
  queuedForConductor: false,
  sessionError: false,
  pendingUserMessages: [],
  pendingApprovals: {},
  threads: {},
  activity: 'idle',
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function withoutKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  if (!(key in record)) {
    return record as Record<string, T>
  }

  const next = { ...record }
  delete next[key]
  return next
}

function withoutApprovalsForThread(
  approvals: Readonly<Record<string, string>>,
  threadId: string,
): Readonly<Record<string, string>> {
  let changed = false
  const next: Record<string, string> = {}

  for (const [approvalId, owner] of Object.entries(approvals)) {
    if (owner === threadId) {
      changed = true
    } else {
      next[approvalId] = owner
    }
  }

  return changed ? next : approvals
}

function uniqueAppend(items: readonly string[], item: string): readonly string[] {
  return items.includes(item) ? items : [...items, item]
}

function ensureAgentThread(
  threads: Readonly<Record<string, TrackedThreadActivity>>,
  threadId: string,
): AgentThreadActivity {
  const existing = threads[threadId]

  if (existing?.kind === 'agent') {
    return existing
  }

  return {
    kind: 'agent',
    definitionName: existing?.definitionName ?? 'agent',
    lineCount: 0,
    midCallLines: 0,
    inTurn: false,
    needsLlmCall: false,
    deferWake: false,
    openToolCalls: {},
  }
}

function threadHasPendingApproval(
  pendingApprovals: Readonly<Record<string, string>>,
  threadId: string,
): boolean {
  return Object.values(pendingApprovals).includes(threadId)
}

function isThreadActivelyWorking(
  state: Omit<SessionActivityState, 'activity'>,
  threadId: string,
  thread: TrackedThreadActivity,
): boolean {
  switch (thread.kind) {
    case 'agent': {
      if (thread.inTurn || thread.needsLlmCall) {
        return true
      }

      const blockedOnApproval = threadHasPendingApproval(state.pendingApprovals, threadId)

      for (const callState of Object.values(thread.openToolCalls)) {
        switch (callState) {
          case 'executing':
            return true
          case 'awaiting_effects':
            if (!blockedOnApproval) {
              return true
            }

            break
          case 'spawned_child':
            break

          default: {
            const exhaustive: never = callState
            return exhaustive
          }
        }
      }

      return false
    }

    case 'evaluator':
      return true

    case 'shuttle-session':
      return (
        !thread.parkedOnMailbox ||
        state.bindingSandbox ||
        state.pendingUserMessages.length > 0 ||
        state.queuedForConductor
      )

    case 'other':
      return thread.activeWaits.length === 0

    default: {
      const exhaustive: never = thread
      return exhaustive
    }
  }
}

export function deriveSessionActivity(
  state: Omit<SessionActivityState, 'activity'>,
): SessionActivity {
  switch (state.runStatus) {
    case 'completed':
    case 'cancelled':
      return 'idle'

    case 'failed':
      return 'error'

    case 'running':
      break

    default: {
      const exhaustive: never = state.runStatus
      return exhaustive
    }
  }

  if (Object.keys(state.pendingApprovals).length > 0) {
    return 'needs_input'
  }

  for (const [threadId, thread] of Object.entries(state.threads)) {
    if (isThreadActivelyWorking(state, threadId, thread)) {
      return 'working'
    }
  }

  if (state.bindingSandbox || state.pendingUserMessages.length > 0 || state.queuedForConductor) {
    return 'working'
  }

  if (state.sessionError) {
    return 'error'
  }

  return 'idle'
}

function withDerivedActivity(next: Omit<SessionActivityState, 'activity'>): SessionActivityState {
  return {
    ...next,
    activity: deriveSessionActivity(next),
  }
}

function putThread(
  state: SessionActivityState,
  threadId: string,
  thread: TrackedThreadActivity,
): SessionActivityState {
  return withDerivedActivity({
    ...state,
    threads: {
      ...state.threads,
      [threadId]: thread,
    },
  })
}

/** Pure session activity fold — keep transitions in sync with apps/worker/src/workspace/activity-state.ts. */
export function reduceSessionActivity(
  state: SessionActivityState,
  event: {
    readonly seq: number
    readonly type: string
    readonly payload: unknown
    readonly threadId?: string | null
  },
): SessionActivityState {
  const payload = asRecord(event.payload)

  switch (event.type) {
    case 'runtime.run.started':
      return withDerivedActivity({
        ...state,
        runStatus: 'running',
        rootThreadId: asString(payload.rootThreadId) ?? state.rootThreadId,
      })

    case 'runtime.run.completed': {
      const failed = Boolean(asString(payload.error))
      return withDerivedActivity({
        ...state,
        runStatus: failed ? 'failed' : 'completed',
        bindingSandbox: false,
        queuedForConductor: false,
        sessionError: failed,
        pendingUserMessages: [],
        pendingApprovals: {},
        threads: {},
      })
    }

    case 'runtime.run.cancelled':
      return withDerivedActivity({
        ...state,
        runStatus: 'cancelled',
        bindingSandbox: false,
        queuedForConductor: false,
        pendingUserMessages: [],
        pendingApprovals: {},
        threads: {},
      })

    case 'runtime.thread.started': {
      const threadId = asString(payload.threadId) ?? asString(event.threadId)

      if (!threadId) {
        return state
      }

      const kind = asString(payload.kind) ?? 'other'
      const definitionName = asString(payload.definitionName) ?? ''

      if (kind === 'shuttle-session') {
        const input = asRecord(payload.input)
        return withDerivedActivity({
          ...state,
          rootThreadId: state.rootThreadId ?? threadId,
          bindingSandbox: Boolean(asString(input.sandboxName)),
          threads: {
            ...state.threads,
            [threadId]: {
              kind: 'shuttle-session',
              definitionName,
              parkedOnMailbox: false,
            },
          },
        })
      }

      if (kind === 'agent') {
        const hasInput = payload.input !== null
        return putThread(state, threadId, {
          kind: 'agent',
          definitionName,
          lineCount: hasInput ? 1 : 0,
          midCallLines: 0,
          inTurn: false,
          needsLlmCall: true,
          deferWake: false,
          openToolCalls: {},
        })
      }

      if (kind === 'evaluator') {
        return putThread(state, threadId, {
          kind: 'evaluator',
          definitionName,
        })
      }

      return putThread(state, threadId, {
        kind: 'other',
        definitionName,
        activeWaits: [],
      })
    }

    case 'runtime.thread.completed':
    case 'runtime.thread.failed':

    case 'runtime.thread.cancelled': {
      const threadId = asString(payload.threadId) ?? asString(event.threadId)

      if (!threadId) {
        return withDerivedActivity({
          ...state,
          bindingSandbox: false,
          sessionError: event.type === 'runtime.thread.failed' ? true : state.sessionError,
          pendingApprovals: {},
          threads: {},
        })
      }

      const nextThreads = withoutKey(state.threads, threadId)
      const nextApprovals = withoutApprovalsForThread(state.pendingApprovals, threadId)

      const isPrimaryThread =
        threadId === state.rootThreadId ||
        threadId === state.conductorThreadId ||
        (!state.conductorThreadId && Object.keys(nextThreads).length === 0)

      return withDerivedActivity({
        ...state,
        bindingSandbox: threadId === state.rootThreadId ? false : state.bindingSandbox,
        sessionError:
          event.type === 'runtime.thread.failed' && isPrimaryThread ? true : state.sessionError,
        pendingApprovals: nextApprovals,
        threads: nextThreads,
      })
    }

    case 'runtime.wait.registered': {
      const threadId = asString(event.threadId) ?? asString(payload.threadId)
      const waitId = asString(payload.waitId)

      if (!threadId || !waitId) {
        return state
      }

      const existing = state.threads[threadId]

      if (!existing) {
        return state
      }

      if (existing.kind === 'shuttle-session') {
        const tag = asRecord(payload.tag)
        return tag.kind === 'shuttle-mailbox'
          ? putThread(state, threadId, { ...existing, parkedOnMailbox: true })
          : state
      }

      if (existing.kind === 'other') {
        return putThread(state, threadId, {
          ...existing,
          activeWaits: uniqueAppend(existing.activeWaits, waitId),
        })
      }

      return state
    }

    case 'runtime.wait.satisfied': {
      const threadId = asString(event.threadId) ?? asString(payload.threadId)
      const waitId = asString(payload.waitId)

      if (!threadId) {
        return state
      }

      const existing = state.threads[threadId]

      if (!existing) {
        return state
      }

      if (existing.kind === 'shuttle-session') {
        const tag = asRecord(payload.tag)
        return tag.kind === 'shuttle-mailbox'
          ? putThread(state, threadId, { ...existing, parkedOnMailbox: false })
          : state
      }

      if (existing.kind === 'other') {
        return putThread(state, threadId, {
          ...existing,
          activeWaits: waitId ? existing.activeWaits.filter((id) => id !== waitId) : [],
        })
      }

      return state
    }

    case 'runtime.effect.completed':

    case 'runtime.effect.failed': {
      const threadId = asString(event.threadId)
      const effectId = asString(payload.effectId)

      if (
        (threadId && threadId === state.rootThreadId) ||
        (effectId && effectId.endsWith(':bind_sandbox'))
      ) {
        return withDerivedActivity({ ...state, bindingSandbox: false })
      }

      return state
    }

    case 'shuttle.sandbox.bound':
      return withDerivedActivity({ ...state, bindingSandbox: false })

    case 'shuttle.conductor.spawned': {
      const childThreadId = asString(payload.childThreadId)
      return withDerivedActivity({
        ...state,
        conductorThreadId: childThreadId ?? state.conductorThreadId,
        queuedForConductor: false,
        sessionError: false,
      })
    }

    case 'shuttle.user.said': {
      const messageId = asString(payload.messageId) ?? `msg_${event.seq}`
      return withDerivedActivity({
        ...state,
        pendingUserMessages: uniqueAppend(state.pendingUserMessages, messageId),
        sessionError: false,
      })
    }

    case 'shuttle.reroute': {
      const messageId = asString(payload.messageId) ?? `reroute_${event.seq}`
      return withDerivedActivity({
        ...state,
        pendingUserMessages: uniqueAppend(state.pendingUserMessages, messageId),
      })
    }

    case 'shuttle.routed': {
      const messageId = asString(payload.messageId)
      return withDerivedActivity({
        ...state,
        pendingUserMessages: messageId
          ? state.pendingUserMessages.filter((id) => id !== messageId)
          : [],
        queuedForConductor: payload.queued === true,
      })
    }

    case 'agent.turn.started': {
      const threadId = asString(event.threadId) ?? DEFAULT_THREAD_ID
      const thread = ensureAgentThread(state.threads, threadId)
      const messageCount = asNumber(payload.messageCount) ?? thread.lineCount
      const arrivedMidCall = thread.lineCount > messageCount

      return withDerivedActivity({
        ...state,
        sessionError: false,
        threads: {
          ...state.threads,
          [threadId]: {
            ...thread,
            inTurn: true,
            needsLlmCall: false,
            deferWake: arrivedMidCall,
            midCallLines: arrivedMidCall ? thread.lineCount - messageCount : 0,
          },
        },
      })
    }

    case 'agent.message': {
      const threadId = asString(event.threadId) ?? DEFAULT_THREAD_ID
      const existing = state.threads[threadId]

      if (existing?.kind !== 'agent') {
        return state
      }

      const message = asRecord(payload.message)
      const toolCallsRaw = Array.isArray(message.toolCalls) ? message.toolCalls : []
      let openToolCalls = existing.openToolCalls

      for (const item of toolCallsRaw) {
        const call = asRecord(item)
        const callId = asString(call.id)

        if (callId && !openToolCalls[callId]) {
          openToolCalls = { ...openToolCalls, [callId]: 'executing' }
        }
      }

      const hasOpenTools = Object.keys(openToolCalls).length > 0

      return putThread(state, threadId, {
        ...existing,
        lineCount: existing.lineCount + 1,
        inTurn: false,
        needsLlmCall: (existing.needsLlmCall || existing.deferWake) && !hasOpenTools,
        deferWake: false,
        midCallLines: 0,
        openToolCalls,
      })
    }

    case 'agent.context.compacted': {
      const threadId = asString(event.threadId) ?? DEFAULT_THREAD_ID
      const existing = state.threads[threadId]

      if (existing?.kind !== 'agent') {
        return state
      }

      const compactedCount = asNumber(payload.compactedCount) ?? existing.lineCount
      return putThread(state, threadId, {
        ...existing,
        lineCount: compactedCount + existing.midCallLines,
      })
    }

    case 'agent.tool_call.requested': {
      const threadId = asString(event.threadId) ?? DEFAULT_THREAD_ID
      const thread = ensureAgentThread(state.threads, threadId)
      const toolCall = asRecord(payload.toolCall)
      const callId = asString(toolCall.id) ?? `call_${event.seq}`

      return putThread(state, threadId, {
        ...thread,
        needsLlmCall: false,
        openToolCalls: {
          ...thread.openToolCalls,
          [callId]: 'executing',
        },
      })
    }

    case 'agent.turn.settled':

    case 'agent.turn.completed': {
      const threadId = asString(event.threadId) ?? DEFAULT_THREAD_ID
      const thread = ensureAgentThread(state.threads, threadId)
      const hasOpenTools = Object.keys(thread.openToolCalls).length > 0

      return putThread(state, threadId, {
        ...thread,
        inTurn: false,
        needsLlmCall: (thread.needsLlmCall || thread.deferWake) && !hasOpenTools,
        deferWake: false,
        midCallLines: 0,
      })
    }

    case 'agent.spawn.requested': {
      const threadId = asString(event.threadId) ?? DEFAULT_THREAD_ID
      const thread = ensureAgentThread(state.threads, threadId)
      const toolCallId = asString(payload.toolCallId)

      if (!toolCallId) {
        return state
      }

      return putThread(state, threadId, {
        ...thread,
        openToolCalls: {
          ...thread.openToolCalls,
          [toolCallId]: 'spawned_child',
        },
      })
    }

    case 'agent.effects.requested': {
      const threadId = asString(event.threadId) ?? DEFAULT_THREAD_ID
      const thread = ensureAgentThread(state.threads, threadId)
      const toolCallId = asString(payload.toolCallId)

      if (!toolCallId) {
        return state
      }

      return putThread(state, threadId, {
        ...thread,
        openToolCalls: {
          ...thread.openToolCalls,
          [toolCallId]: 'awaiting_effects',
        },
      })
    }

    case 'agent.tool.result': {
      const threadId = asString(event.threadId) ?? DEFAULT_THREAD_ID
      const thread = ensureAgentThread(state.threads, threadId)
      const toolCallId = asString(payload.toolCallId)
      const openToolCalls = toolCallId ? withoutKey(thread.openToolCalls, toolCallId) : {}

      return putThread(state, threadId, {
        ...thread,
        lineCount: thread.lineCount + 1,
        openToolCalls,
        needsLlmCall: Object.keys(openToolCalls).length === 0,
      })
    }

    case 'agent.message.received': {
      const threadId = asString(event.threadId) ?? DEFAULT_THREAD_ID
      const thread = ensureAgentThread(state.threads, threadId)

      return putThread(state, threadId, {
        ...thread,
        lineCount: thread.lineCount + 1,
        needsLlmCall: Object.keys(thread.openToolCalls).length === 0,
      })
    }

    case 'agent.steered': {
      const threadId = asString(event.threadId) ?? DEFAULT_THREAD_ID
      const thread = ensureAgentThread(state.threads, threadId)
      const interrupt = payload.interrupt === true

      if (interrupt) {
        return withDerivedActivity({
          ...state,
          pendingApprovals: withoutApprovalsForThread(state.pendingApprovals, threadId),
          threads: {
            ...state.threads,
            [threadId]: {
              ...thread,
              lineCount: thread.lineCount + 1,
              midCallLines: 0,
              inTurn: false,
              needsLlmCall: true,
              deferWake: false,
              openToolCalls: {},
            },
          },
        })
      }

      return putThread(state, threadId, {
        ...thread,
        lineCount: thread.lineCount + 1,
        needsLlmCall: Object.keys(thread.openToolCalls).length === 0,
      })
    }

    case 'agent.turn.stopped': {
      const threadId = asString(event.threadId) ?? DEFAULT_THREAD_ID
      const existing = state.threads[threadId]
      const nextApprovals = withoutApprovalsForThread(state.pendingApprovals, threadId)

      if (existing?.kind !== 'agent') {
        return nextApprovals === state.pendingApprovals
          ? state
          : withDerivedActivity({ ...state, pendingApprovals: nextApprovals })
      }

      return withDerivedActivity({
        ...state,
        pendingApprovals: nextApprovals,
        threads: {
          ...state.threads,
          [threadId]: {
            ...existing,
            midCallLines: 0,
            inTurn: false,
            needsLlmCall: false,
            deferWake: false,
            openToolCalls: {},
          },
        },
      })
    }

    case 'approval.requested': {
      const approvalId = asString(payload.approvalId) ?? `approval_${event.seq}`
      const owner = asString(event.threadId) ?? DEFAULT_THREAD_ID

      return withDerivedActivity({
        ...state,
        pendingApprovals: {
          ...state.pendingApprovals,
          [approvalId]: owner,
        },
      })
    }

    case 'approval.decided':

    case 'approval.timed_out': {
      const approvalId = asString(payload.approvalId)

      return withDerivedActivity({
        ...state,
        pendingApprovals: approvalId ? withoutKey(state.pendingApprovals, approvalId) : {},
      })
    }

    default:
      return state
  }
}

export const sessionActivity: ProjectionDefinition<SessionActivityState> = {
  name: 'shuttleSessionActivity',
  initialState: initialSessionActivityState,
  reduce(state, event: AnyEventEnvelope) {
    return reduceSessionActivity(state, event)
  },
}

/** Resolve a single thread node's true live status for AgentTree. */
export function resolveThreadActivityTone(
  state: SessionActivityState,
  node: Pick<ThreadNode, 'threadId' | 'kind' | 'status'>,
): ThreadActivityTone {
  if (node.status === 'completed' || node.status === 'failed' || node.status === 'cancelled') {
    return node.status
  }

  if (
    state.runStatus === 'completed' ||
    state.runStatus === 'failed' ||
    state.runStatus === 'cancelled'
  ) {
    return state.runStatus
  }

  if (threadHasPendingApproval(state.pendingApprovals, node.threadId)) {
    return 'needs_input'
  }

  const tracked = state.threads[node.threadId]

  if (!tracked) {
    return node.status === 'waiting' ? 'idle' : 'working'
  }

  switch (tracked.kind) {
    case 'shuttle-session': {
      switch (state.activity) {
        case 'needs_input':
          return 'needs_input'
        case 'working':
          return 'working'
        case 'error':
          return 'failed'
        case 'idle':
          return 'idle'

        default: {
          const exhaustive: never = state.activity
          return exhaustive
        }
      }
    }

    case 'agent': {
      if (isThreadActivelyWorking(state, node.threadId, tracked)) {
        return 'working'
      }

      if (Object.values(tracked.openToolCalls).includes('spawned_child')) {
        return 'delegating'
      }

      return 'idle'
    }

    case 'evaluator':
      return 'working'

    case 'other':
      return tracked.activeWaits.length > 0 ? 'idle' : 'working'

    default: {
      const exhaustive: never = tracked
      return exhaustive
    }
  }
}

export function resolveSessionIndicator(input: {
  readonly status: string
  readonly activity: string
  readonly unread?: boolean
}): SessionIndicatorTone {
  if (input.status === 'failed') {
    return 'failed'
  }

  if (input.status === 'cancelled') {
    return 'cancelled'
  }

  if (input.status === 'completed') {
    return input.unread ? 'ready' : 'completed'
  }

  if (input.status === 'requested') {
    return 'starting'
  }

  switch (input.activity) {
    case 'needs_input':
      return 'needs_input'
    case 'working':
      return 'working'
    case 'error':
      return 'failed'
    default:
      return input.unread ? 'ready' : 'idle'
  }
}

const SESSION_INDICATOR_LABELS: Record<SessionIndicatorTone, string> = {
  starting: 'Starting',
  working: 'Working',
  needs_input: 'Needs input',
  ready: 'Ready for review',
  failed: 'Failed',
  idle: 'Idle',
  completed: 'Completed',
  cancelled: 'Cancelled',
}

export function sessionIndicatorLabel(tone: SessionIndicatorTone): string {
  return SESSION_INDICATOR_LABELS[tone]
}

export interface FolderIndicatorRollup {
  readonly tone: 'needs_input' | 'failed' | 'working' | 'ready'
  readonly count: number
  readonly label: string
}

const ROUTE_WAIT_FALLBACK_MS = 5_000

export interface RouteWaitFallback {
  readonly threadId: string
  readonly toolName: string
  readonly elapsedMs: number
}

/** An agent thread (not a narrator) that is mid-turn or executing a tool, for route wait UX. */
export function findInFlightToolCall(
  activity: Omit<SessionActivityState, 'activity'>,
): { readonly threadId: string; readonly toolName: string } | null {
  let pick: { threadId: string; toolName: string } | null = null

  for (const [threadId, thread] of Object.entries(activity.threads)) {
    if (thread.kind !== 'agent' || thread.definitionName === 'narrator') {
      continue
    }

    if (thread.inTurn) {
      return { threadId, toolName: 'turn' }
    }

    if (!pick && Object.values(thread.openToolCalls).includes('executing')) {
      pick = { threadId, toolName: 'tool' }
    }
  }

  return pick
}

/** Prefer feed tool rows when names and timestamps are available. */
export function findRunningToolInFeed(feed: SessionFeed): {
  readonly threadId: string
  readonly call: ToolCallItem
} | null {
  for (let index = feed.items.length - 1; index >= 0; index -= 1) {
    const item = feed.items[index]

    if (item?.kind !== 'tools') {
      continue
    }

    const running = item.calls.filter((call) => call.status === 'running')

    if (running.length === 0) {
      continue
    }

    return { threadId: item.threadId, call: running[running.length - 1]! }
  }

  return null
}

export function shouldShowRouteWaitFallback(
  messageTs: number,
  hasRoute: boolean,
  now: number,
): boolean {
  return !hasRoute && now - messageTs >= ROUTE_WAIT_FALLBACK_MS
}

export function deriveRouteWaitFallback(input: {
  readonly messageTs: number
  readonly hasRoute: boolean
  readonly now: number
  readonly activity: SessionActivityState
  readonly feed: SessionFeed
}): RouteWaitFallback | null {
  if (!shouldShowRouteWaitFallback(input.messageTs, input.hasRoute, input.now)) {
    return null
  }

  const fromFeed = findRunningToolInFeed(input.feed)

  if (fromFeed) {
    const elapsedMs = Math.max(0, input.now - (fromFeed.call.startedAt ?? input.messageTs))

    return {
      threadId: fromFeed.threadId,
      toolName: fromFeed.call.name,
      elapsedMs,
    }
  }

  const fromActivity = findInFlightToolCall(input.activity)

  if (!fromActivity) {
    return null
  }

  return {
    threadId: fromActivity.threadId,
    toolName: fromActivity.toolName,
    elapsedMs: Math.max(0, input.now - input.messageTs),
  }
}

/**
 * Summarize actionable session states inside a collapsed folder or hidden overflow slice.
 * Returns `null` when every session is quiet (`idle`, `completed`, `cancelled`).
 */
export function resolveFolderIndicator(
  tones: readonly SessionIndicatorTone[],
): FolderIndicatorRollup | null {
  let needsInput = 0
  let failed = 0
  let working = 0
  let ready = 0

  for (const tone of tones) {
    switch (tone) {
      case 'needs_input':
        needsInput += 1
        break
      case 'failed':
        failed += 1
        break
      case 'starting':
      case 'working':
        working += 1
        break
      case 'ready':
        ready += 1
        break
      case 'idle':
      case 'completed':
      case 'cancelled':
        break

      default: {
        const exhaustive: never = tone
        void exhaustive
      }
    }
  }

  if (needsInput > 0) {
    return {
      tone: 'needs_input',
      count: needsInput,
      label: needsInput === 1 ? '1 session needs input' : `${needsInput} sessions need input`,
    }
  }

  if (failed > 0) {
    return {
      tone: 'failed',
      count: failed,
      label: failed === 1 ? '1 session failed' : `${failed} sessions failed`,
    }
  }

  if (working > 0) {
    return {
      tone: 'working',
      count: working,
      label: working === 1 ? '1 session working' : `${working} sessions working`,
    }
  }

  if (ready > 0) {
    return {
      tone: 'ready',
      count: ready,
      label: ready === 1 ? '1 session ready for review' : `${ready} sessions ready for review`,
    }
  }

  return null
}

import type { SessionActivity } from './scope'

export type OpenToolCallState = 'executing' | 'spawned_child' | 'awaiting_effects'

export interface AgentThreadActivity {
  readonly kind: 'agent'
  readonly definitionName: string
  readonly lineCount: number
  readonly midCallLines: number
  readonly inTurn: boolean
  readonly needsLlmCall: boolean
  readonly deferWake: boolean
  readonly openToolCalls: Readonly<Record<string, OpenToolCallState>>
}

export interface EvaluatorThreadActivity {
  readonly kind: 'evaluator'
  readonly definitionName: string
}

export interface SessionCoordinatorActivity {
  readonly kind: 'shuttle-session'
  readonly definitionName: string
  readonly parkedOnMailbox: boolean
}

export interface GenericThreadActivity {
  readonly kind: 'other'
  readonly definitionName: string
  readonly activeWaits: readonly string[]
}

export type TrackedThreadActivity =
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
  /** Maps open `approvalId` -> owning `threadId`. */
  readonly pendingApprovals: Readonly<Record<string, string>>
  readonly threads: Readonly<Record<string, TrackedThreadActivity>>
}

export interface ActivityEventLike {
  readonly seq: number
  readonly type: string
  readonly payload: unknown
  readonly threadId?: string | null
  readonly effectId?: string | null
  readonly id?: string
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

function putThread(
  state: SessionActivityState,
  threadId: string,
  thread: TrackedThreadActivity,
): SessionActivityState {
  return {
    ...state,
    threads: {
      ...state.threads,
      [threadId]: thread,
    },
  }
}

function threadHasPendingApproval(state: SessionActivityState, threadId: string): boolean {
  return Object.values(state.pendingApprovals).includes(threadId)
}

export function isThreadActivelyWorking(
  state: SessionActivityState,
  threadId: string,
  thread: TrackedThreadActivity,
): boolean {
  switch (thread.kind) {
    case 'agent': {
      if (thread.inTurn || thread.needsLlmCall) {
        return true
      }

      const blockedOnApproval = threadHasPendingApproval(state, threadId)

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

export function deriveSessionActivity(state: SessionActivityState): SessionActivity {
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

export function reduceSessionActivity(
  state: SessionActivityState,
  event: ActivityEventLike,
): SessionActivityState {
  const payload = asRecord(event.payload)

  switch (event.type) {
    case 'runtime.run.started': {
      return {
        ...state,
        runStatus: 'running',
        rootThreadId: asString(payload.rootThreadId) ?? state.rootThreadId,
      }
    }

    case 'runtime.run.completed': {
      const failed = Boolean(asString(payload.error))
      return {
        ...state,
        runStatus: failed ? 'failed' : 'completed',
        bindingSandbox: false,
        queuedForConductor: false,
        sessionError: failed,
        pendingUserMessages: [],
        pendingApprovals: {},
        threads: {},
      }
    }

    case 'runtime.run.cancelled': {
      return {
        ...state,
        runStatus: 'cancelled',
        bindingSandbox: false,
        queuedForConductor: false,
        pendingUserMessages: [],
        pendingApprovals: {},
        threads: {},
      }
    }

    case 'runtime.thread.started': {
      const threadId = asString(payload.threadId) ?? asString(event.threadId)

      if (!threadId) {
        return state
      }

      const kind = asString(payload.kind) ?? 'other'
      const definitionName = asString(payload.definitionName) ?? ''

      if (kind === 'shuttle-session') {
        const input = asRecord(payload.input)
        return {
          ...putThread(state, threadId, {
            kind: 'shuttle-session',
            definitionName,
            parkedOnMailbox: false,
          }),
          rootThreadId: state.rootThreadId ?? threadId,
          bindingSandbox: Boolean(asString(input.sandboxName)),
        }
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
        return {
          ...state,
          bindingSandbox: false,
          sessionError: event.type === 'runtime.thread.failed' ? true : state.sessionError,
          pendingApprovals: {},
          threads: {},
        }
      }

      const nextThreads = withoutKey(state.threads, threadId)
      const nextApprovals = withoutApprovalsForThread(state.pendingApprovals, threadId)

      const isPrimaryThread =
        threadId === state.rootThreadId ||
        threadId === state.conductorThreadId ||
        (!state.conductorThreadId && Object.keys(nextThreads).length === 0)

      return {
        ...state,
        bindingSandbox: threadId === state.rootThreadId ? false : state.bindingSandbox,
        sessionError:
          event.type === 'runtime.thread.failed' && isPrimaryThread ? true : state.sessionError,
        pendingApprovals: nextApprovals,
        threads: nextThreads,
      }
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

        if (tag.kind === 'shuttle-mailbox') {
          return putThread(state, threadId, { ...existing, parkedOnMailbox: true })
        }

        return state
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

        if (tag.kind === 'shuttle-mailbox') {
          return putThread(state, threadId, { ...existing, parkedOnMailbox: false })
        }

        return state
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
      const effectId = asString(payload.effectId) ?? asString(event.effectId)

      if (
        (threadId && threadId === state.rootThreadId) ||
        (effectId && effectId.endsWith(':bind_sandbox'))
      ) {
        return { ...state, bindingSandbox: false }
      }

      return state
    }

    case 'shuttle.sandbox.bound':
      return { ...state, bindingSandbox: false }

    case 'shuttle.conductor.spawned': {
      const childThreadId = asString(payload.childThreadId)
      return {
        ...state,
        conductorThreadId: childThreadId ?? state.conductorThreadId,
        queuedForConductor: false,
        sessionError: false,
      }
    }

    case 'shuttle.user.said': {
      const messageId = asString(payload.messageId) ?? `msg_${event.seq}`
      return {
        ...state,
        pendingUserMessages: uniqueAppend(state.pendingUserMessages, messageId),
        sessionError: false,
      }
    }

    case 'shuttle.reroute': {
      const messageId = asString(payload.messageId) ?? `reroute_${event.seq}`
      return {
        ...state,
        pendingUserMessages: uniqueAppend(state.pendingUserMessages, messageId),
      }
    }

    case 'shuttle.routed': {
      const messageId = asString(payload.messageId)
      return {
        ...state,
        pendingUserMessages: messageId
          ? state.pendingUserMessages.filter((id) => id !== messageId)
          : [],
        queuedForConductor: payload.queued === true,
      }
    }

    case 'agent.turn.started': {
      const threadId = asString(event.threadId) ?? DEFAULT_THREAD_ID
      const thread = ensureAgentThread(state.threads, threadId)
      const messageCount = asNumber(payload.messageCount) ?? thread.lineCount
      const arrivedMidCall = thread.lineCount > messageCount

      return {
        ...putThread(state, threadId, {
          ...thread,
          inTurn: true,
          needsLlmCall: false,
          deferWake: arrivedMidCall,
          midCallLines: arrivedMidCall ? thread.lineCount - messageCount : 0,
        }),
        sessionError: false,
      }
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
        return {
          ...putThread(state, threadId, {
            ...thread,
            lineCount: thread.lineCount + 1,
            midCallLines: 0,
            inTurn: false,
            needsLlmCall: true,
            deferWake: false,
            openToolCalls: {},
          }),
          pendingApprovals: withoutApprovalsForThread(state.pendingApprovals, threadId),
        }
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
          : { ...state, pendingApprovals: nextApprovals }
      }

      return {
        ...putThread(state, threadId, {
          ...existing,
          midCallLines: 0,
          inTurn: false,
          needsLlmCall: false,
          deferWake: false,
          openToolCalls: {},
        }),
        pendingApprovals: nextApprovals,
      }
    }

    case 'approval.requested': {
      const approvalId = asString(payload.approvalId) ?? `approval_${event.seq}`
      const owner = asString(event.threadId) ?? DEFAULT_THREAD_ID

      return {
        ...state,
        pendingApprovals: {
          ...state.pendingApprovals,
          [approvalId]: owner,
        },
      }
    }

    case 'approval.decided':

    case 'approval.timed_out': {
      const approvalId = asString(payload.approvalId)

      return {
        ...state,
        pendingApprovals: approvalId ? withoutKey(state.pendingApprovals, approvalId) : {},
      }
    }

    default:
      return state
  }
}

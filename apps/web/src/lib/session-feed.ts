import type { JsonValue, ProjectionDefinition } from '@swirls/looms/core'
import type { LiveFoldDefinition } from '@swirls/looms/react'

import type { SessionEvent } from './event-catalog'
import { jsonFields, jsonNumber, jsonText } from './json'

export const interjectionKinds = [
  'question',
  'idea',
  'constraint',
  'correction',
  'task',
  'stop',
] as const

export type InterjectionKind = (typeof interjectionKinds)[number]

export function isInterjectionKind(value: string | undefined): value is InterjectionKind {
  return interjectionKinds.some((kind) => kind === value)
}

export interface RouteDelivery {
  readonly threadId: string
  readonly interrupt: boolean
}

export interface RouteInfo {
  readonly kind: InterjectionKind
  readonly summary: string
  readonly targetThreadId: string | null
  readonly briefVersion?: number
}

export interface ToolCallItem {
  readonly toolCallId: string
  readonly name: string
  readonly args: JsonValue
  readonly seq: number
  readonly status: 'running' | 'ok' | 'error'
  readonly result?: JsonValue
  readonly error?: string
}

export type FeedItem =
  | {
      readonly kind: 'user'
      readonly id: string
      readonly seq: number
      readonly ts: number
      readonly messageId: string
      readonly text: string
      readonly goal: boolean
      readonly forced?: InterjectionKind
    }
  | {
      readonly kind: 'agent'
      readonly id: string
      readonly seq: number
      readonly ts: number
      readonly threadId: string
      readonly text: string
      readonly replyTo?: string
    }
  | {
      readonly kind: 'tools'
      readonly id: string
      readonly seq: number
      readonly ts: number
      readonly threadId: string
      readonly calls: readonly ToolCallItem[]
    }
  | {
      readonly kind: 'question'
      readonly id: string
      readonly seq: number
      readonly ts: number
      readonly threadId: string
      readonly approvalId: string
      readonly title: string
      readonly decision?: { readonly answer: string | null }
    }
  | {
      readonly kind: 'notice'
      readonly id: string
      readonly seq: number
      readonly ts: number
      readonly tone: 'info' | 'success' | 'error'
      readonly text: string
      readonly threadId?: string
      readonly runId?: string
    }

export interface BriefRevision {
  readonly version: number
  readonly text: string
  readonly ts: number
  readonly sourceMessageId?: string
}

export interface SessionFeed {
  readonly items: readonly FeedItem[]
  readonly routes: Readonly<Record<string, RouteInfo>>
  /** Steers and narrator spawns land before `shuttle.routed`, so they key on message id alone. */
  readonly deliveries: Readonly<Record<string, readonly RouteDelivery[]>>
  readonly narratorFor: Readonly<Record<string, string>>
  readonly classifying: Readonly<Record<string, true>>
  readonly messageText: Readonly<Record<string, string>>
  readonly brief: readonly BriefRevision[]
  readonly playbook: { readonly version: number; readonly lessons: readonly PlaybookLessonRef[] }
  readonly reflectionRunId?: string
  readonly rootThreadId?: string
  readonly narrators: Readonly<Record<string, string>>
  readonly toolIndex: Readonly<Record<string, number>>
  readonly questionIndex: Readonly<Record<string, number>>
}

export interface PlaybookLessonRef {
  readonly id: string
  readonly text: string
  readonly scope?: string
}

const initialFeed: SessionFeed = {
  items: [],
  routes: {},
  deliveries: {},
  narratorFor: {},
  classifying: {},
  messageText: {},
  brief: [],
  playbook: { version: 0, lessons: [] },
  narrators: {},
  toolIndex: {},
  questionIndex: {},
}

function withoutKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const next = { ...record }
  delete next[key]
  return next
}

function appendItem(feed: SessionFeed, item: FeedItem): SessionFeed {
  return { ...feed, items: [...feed.items, item] }
}

function onToolCall(feed: SessionFeed, event: SessionEvent): SessionFeed {
  const payload = jsonFields(event.payload)
  const call = jsonFields(payload.toolCall)
  const toolCallId = jsonText(call.id)
  const threadId = event.threadId

  const name = jsonText(call.name) ?? 'tool'

  // `ask_user` surfaces as a question card from its approval gate instead.
  if (!toolCallId || !threadId || name === 'ask_user' || feed.toolIndex[toolCallId] !== undefined) {
    return feed
  }

  const item: ToolCallItem = {
    toolCallId,
    name,
    args: call.arguments ?? null,
    seq: event.seq,
    status: 'running',
  }

  const last = feed.items.at(-1)

  // Consecutive calls from one agent collapse into a single activity row.
  if (last?.kind === 'tools' && last.threadId === threadId) {
    const index = feed.items.length - 1
    const items = [...feed.items]
    items[index] = { ...last, calls: [...last.calls, item] }
    return { ...feed, items, toolIndex: { ...feed.toolIndex, [toolCallId]: index } }
  }

  return {
    ...appendItem(feed, {
      kind: 'tools',
      id: event.id,
      seq: event.seq,
      ts: event.ts,
      threadId,
      calls: [item],
    }),
    toolIndex: { ...feed.toolIndex, [toolCallId]: feed.items.length },
  }
}

function onToolResult(feed: SessionFeed, event: SessionEvent): SessionFeed {
  const payload = jsonFields(event.payload)
  const toolCallId = jsonText(payload.toolCallId)
  const index = toolCallId ? feed.toolIndex[toolCallId] : undefined
  const group = index === undefined ? undefined : feed.items[index]

  if (index === undefined || group?.kind !== 'tools') {
    return feed
  }

  const error = jsonText(payload.error) ?? undefined
  const items = [...feed.items]

  items[index] = {
    ...group,
    calls: group.calls.map((call) =>
      call.toolCallId === toolCallId
        ? {
            ...call,
            status: error ? 'error' : 'ok',
            result: payload.result ?? null,
            error,
          }
        : call,
    ),
  }

  return { ...feed, items }
}

function reduceFeed(feed: SessionFeed, event: SessionEvent): SessionFeed {
  const payload = jsonFields(event.payload)

  switch (event.type) {
    case 'runtime.thread.started': {
      if (feed.rootThreadId || event.parentThreadId) {
        return feed
      }

      const goal = jsonText(jsonFields(payload.input).goal)

      if (!goal || !event.threadId) {
        return { ...feed, rootThreadId: event.threadId ?? undefined }
      }

      return {
        ...appendItem(feed, {
          kind: 'user',
          id: event.id,
          seq: event.seq,
          ts: event.ts,
          messageId: `goal_${event.id}`,
          text: goal,
          goal: true,
        }),
        rootThreadId: event.threadId,
        brief: [{ version: 1, text: goal, ts: event.ts }],
      }
    }

    case 'shuttle.user.said': {
      const messageId = jsonText(payload.messageId)
      const text = jsonText(payload.text)

      if (!messageId || !text) {
        return feed
      }

      const forced = jsonText(payload.forceKind)

      return {
        ...appendItem(feed, {
          kind: 'user',
          id: event.id,
          seq: event.seq,
          ts: event.ts,
          messageId,
          text,
          goal: false,
          forced: isInterjectionKind(forced) ? forced : undefined,
        }),
        messageText: { ...feed.messageText, [messageId]: text },
      }
    }

    case 'shuttle.intake.started': {
      const messageId = jsonText(payload.messageId)
      return messageId ? { ...feed, classifying: { ...feed.classifying, [messageId]: true } } : feed
    }

    case 'shuttle.routed': {
      const messageId = jsonText(payload.messageId)
      const kind = jsonText(payload.kind)

      if (!messageId || !isInterjectionKind(kind)) {
        return feed
      }

      return {
        ...feed,
        classifying: withoutKey(feed.classifying, messageId),
        routes: {
          ...feed.routes,
          [messageId]: {
            kind,
            summary: jsonText(payload.summary) ?? '',
            targetThreadId: jsonText(payload.targetThreadId) ?? null,
            briefVersion: jsonNumber(payload.briefVersion),
          },
        },
      }
    }

    case 'shuttle.narrator.spawned': {
      const messageId = jsonText(payload.messageId)
      const childThreadId = jsonText(payload.childThreadId)

      if (!messageId || !childThreadId) {
        return feed
      }

      return {
        ...feed,
        narrators: { ...feed.narrators, [childThreadId]: messageId },
        narratorFor: { ...feed.narratorFor, [messageId]: childThreadId },
      }
    }

    case 'shuttle.brief.amended': {
      const version = jsonNumber(payload.version)
      const text = jsonText(payload.text)

      if (version === undefined || text === undefined) {
        return feed
      }

      return {
        ...feed,
        brief: [
          ...feed.brief.filter((revision) => revision.version !== version),
          { version, text, ts: event.ts, sourceMessageId: jsonText(payload.sourceMessageId) },
        ],
      }
    }

    case 'shuttle.playbook.loaded': {
      const lessons = Array.isArray(payload.lessons) ? payload.lessons : []
      return {
        ...feed,
        playbook: {
          version: jsonNumber(payload.version) ?? 0,
          lessons: lessons.flatMap((lesson) => {
            const fields = jsonFields(lesson)
            const id = jsonText(fields.id)
            const text = jsonText(fields.text)
            return id && text ? [{ id, text, scope: jsonText(fields.scope) }] : []
          }),
        },
      }
    }

    case 'shuttle.conductor.spawned': {
      const generation = jsonNumber(payload.generation) ?? 0
      const reason = jsonText(payload.reason)

      if (generation <= 0) {
        return feed
      }

      const reasonLabel = reason && reason !== 'initial' ? ` after ${reason}` : ''

      return appendItem(feed, {
        kind: 'notice',
        id: event.id,
        seq: event.seq,
        ts: event.ts,
        tone: 'info',
        text: `Conductor restarted (generation ${generation})${reasonLabel}.`,
      })
    }

    case 'shuttle.reflection.launched': {
      const runId = jsonText(payload.runId)

      if (!runId) {
        return feed
      }

      return {
        ...appendItem(feed, {
          kind: 'notice',
          id: event.id,
          seq: event.seq,
          ts: event.ts,
          tone: 'info',
          text: 'Session idle. Reflection run launched to mine lessons from this history.',
          runId,
        }),
        reflectionRunId: runId,
      }
    }

    case 'agent.steered': {
      const messageId = jsonText(payload.messageId)

      if (!messageId || !event.threadId) {
        return feed
      }

      const delivery: RouteDelivery = {
        threadId: event.threadId,
        interrupt: payload.interrupt === true,
      }

      return {
        ...feed,
        deliveries: {
          ...feed.deliveries,
          [messageId]: [...(feed.deliveries[messageId] ?? []), delivery],
        },
      }
    }

    case 'agent.message': {
      const message = jsonFields(payload.message)
      const text = jsonText(message.content)?.trim()

      if (message.role !== 'assistant' || !text || !event.threadId) {
        return feed
      }

      return appendItem(feed, {
        kind: 'agent',
        id: event.id,
        seq: event.seq,
        ts: event.ts,
        threadId: event.threadId,
        text,
        replyTo: feed.narrators[event.threadId],
      })
    }

    case 'agent.tool_call.requested':
      return onToolCall(feed, event)

    case 'approval.requested': {
      const approvalId = jsonText(payload.approvalId)

      if (!approvalId || !event.threadId || feed.questionIndex[approvalId] !== undefined) {
        return feed
      }

      return {
        ...appendItem(feed, {
          kind: 'question',
          id: event.id,
          seq: event.seq,
          ts: event.ts,
          threadId: event.threadId,
          approvalId,
          title: jsonText(payload.title) ?? 'The agent needs your input',
        }),
        questionIndex: { ...feed.questionIndex, [approvalId]: feed.items.length },
      }
    }

    case 'approval.decided': {
      const approvalId = jsonText(payload.approvalId)
      const index = approvalId ? feed.questionIndex[approvalId] : undefined
      const question = index === undefined ? undefined : feed.items[index]

      if (index === undefined || question?.kind !== 'question') {
        return feed
      }

      const answer =
        payload.outcome === 'approve'
          ? (jsonText(jsonFields(payload.payload).answer) ?? 'Approved')
          : null

      const items = [...feed.items]
      items[index] = { ...question, decision: { answer } }
      return { ...feed, items }
    }

    case 'agent.tool.result':
      return onToolResult(feed, event)

    case 'runtime.thread.failed':
      return appendItem(feed, {
        kind: 'notice',
        id: event.id,
        seq: event.seq,
        ts: event.ts,
        tone: 'error',
        text: jsonText(payload.error) ?? 'Thread failed',
        threadId: event.threadId ?? undefined,
      })

    case 'agent.turn.stopped':
      return appendItem(feed, {
        kind: 'notice',
        id: event.id,
        seq: event.seq,
        ts: event.ts,
        tone: 'info',
        text: 'Stopped',
        threadId: event.threadId ?? undefined,
      })

    default:
      return feed
  }
}

export const sessionFeed: ProjectionDefinition<SessionFeed> = {
  name: 'shuttleSessionFeed',
  initialState: initialFeed,
  reduce: reduceFeed,
}

/** Text each agent has streamed since its last durable message. */
export const streamingText: LiveFoldDefinition<Readonly<Record<string, string>>, SessionEvent> = {
  kind: 'liveFold',
  name: 'shuttleStreamingText',
  initialState: {},
  reduce(state, event) {
    const threadId = event.threadId

    if (!threadId) {
      return state
    }

    if (
      event.type === 'agent.message' ||
      event.type === 'agent.turn.stopped' ||
      event.type === 'runtime.thread.completed' ||
      event.type === 'runtime.thread.failed' ||
      event.type === 'runtime.thread.cancelled'
    ) {
      return threadId in state ? withoutKey(state, threadId) : state
    }

    if (event.type === 'agent.turn.text_delta') {
      const delta = jsonText(jsonFields(event.payload).delta)
      return delta ? { ...state, [threadId]: `${state[threadId] ?? ''}${delta}` } : state
    }

    return state
  },
}

export function currentBrief(feed: SessionFeed): BriefRevision | undefined {
  return feed.brief.toSorted((left, right) => right.version - left.version)[0]
}

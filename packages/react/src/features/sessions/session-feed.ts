import { z } from 'zod'

import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type ProjectionDefinition,
} from '@swirls/looms/core'
import type { LiveFoldDefinition } from '@swirls/looms/react'

import { jsonFields, jsonNumber, jsonText } from '../../lib/json'
import { hasText } from '../../lib/text'
import type { SessionEvent } from '../events/event-catalog'
import { mediaAssetsOf, sharedAssetOf, type MediaAsset, type SessionMedia } from './media'
import { mentionReferencesOf, type MentionReference } from './mentions/tokens'

/** The fields of an event's payload, or no fields when the payload is not a JSON object. */
export function eventFields(event: SessionEvent): JsonObject {
  return isJsonObject(event.payload) ? event.payload : {}
}

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
  readonly startedAt?: number
  readonly result?: JsonValue
  readonly error?: string
}

export interface ThoughtInfo {
  readonly id: string
  readonly text: string
  readonly durationMs?: number
  readonly seq: number
  readonly ts: number
  readonly turn: number
}

export type ActivityStep =
  | { readonly kind: 'thought'; readonly thought: ThoughtInfo }
  | { readonly kind: 'call'; readonly call: ToolCallItem }

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
      /** Who sent it. Absent on the goal and on messages from before people signed in. */
      readonly author?: MessageAuthor
      /** Files sent with the message. */
      readonly attachments?: readonly MediaAsset[]
      /** Files and sessions the message points at with `@`. */
      readonly references?: readonly MentionReference[]
    }
  | {
      /** Files an agent shared for the people in the session to see. */
      readonly kind: 'media'
      readonly id: string
      readonly seq: number
      readonly ts: number
      readonly threadId: string
      readonly assets: readonly MediaAsset[]
    }
  | {
      readonly kind: 'agent'
      readonly id: string
      readonly seq: number
      readonly ts: number
      readonly threadId: string
      readonly text: string
      readonly replyTo?: string
      readonly thought?: ThoughtInfo
    }
  | {
      readonly kind: 'thought'
      readonly id: string
      readonly seq: number
      readonly ts: number
      readonly threadId: string
      readonly turn: number
      readonly text: string
      readonly durationMs?: number
    }
  | {
      readonly kind: 'tools'
      readonly id: string
      readonly seq: number
      readonly ts: number
      readonly threadId: string
      readonly calls: readonly ToolCallItem[]
      readonly thoughts: readonly ThoughtInfo[]
      readonly steps: readonly ActivityStep[]
    }
  | {
      readonly kind: 'question'
      readonly id: string
      readonly seq: number
      readonly ts: number
      readonly threadId: string
      readonly approvalId: string
      readonly title: string
      readonly thought?: ThoughtInfo
      readonly decision?: { readonly answer: string | null; readonly ts?: number }
      /** Values the agent proposed, from the approval schema's field defaults. */
      readonly defaults?: Readonly<Record<string, JsonValue>>
      /** What happened after a PR publish approval. */
      readonly publish?:
        | { readonly status: 'published'; readonly pulls: readonly PublishedPull[] }
        | { readonly status: 'failed'; readonly error: string }
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

export interface PublishedPull {
  readonly fullName: string
  readonly number: number
  readonly url: string
  readonly draft: boolean
  /** What publishing did to it. Absent in events from before it was recorded. */
  readonly outcome?: 'opened' | 'updated' | 'unchanged'
  /** Agent thread that proposed the PR. */
  readonly threadId?: string
  /** Shuttle stack membership; absent when the PR can't be placed in a stack. */
  readonly stack?: PullStackPosition
}

/** The recorded outcome of publishing a pull request; anything else counts as not recorded. */
function publishOutcome(value: string | undefined): PublishedPull['outcome'] {
  return value === 'opened' || value === 'updated' || value === 'unchanged' ? value : undefined
}

export interface PullStackPosition {
  /** Independent stack within the repo; a one-layer stack is a standalone PR. */
  readonly id: number
  readonly layer: number
}

export type ReviewVerdict = 'approve' | 'request_changes' | 'comment'

function reviewVerdict(value: JsonValue | undefined): ReviewVerdict | undefined {
  return value === 'approve' || value === 'request_changes' || value === 'comment'
    ? value
    : undefined
}

export interface DraftReviewComment {
  readonly commentId: string
  readonly path: string
  readonly line: number
  readonly side: 'LEFT' | 'RIGHT'
  readonly severity: 'info' | 'warning' | 'error'
  readonly body: string
  readonly suggestion?: string
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
  /** Holds a turn's thought until its message, tool call, or approval arrives. */
  readonly pendingThoughts: Readonly<Record<string, ThoughtInfo>>
  /** Threads with a model turn in progress. */
  readonly openTurns: Readonly<Record<string, true>>
  /**
   * Messages, by id, that reached an agent in the middle of a turn, with the thread they wait
   * for. The agent reads them when that turn ends, so that is where they belong in the feed.
   */
  readonly queued: Readonly<Record<string, string>>
  /** Every file in the session, oldest first: those people attached and those agents shared. */
  readonly media: readonly SessionMedia[]
  /** PRs this session opened (from shuttle.pr.published). */
  readonly publishedPulls: readonly PublishedPull[]
  /** Inline review comments drafted during a review session. */
  readonly draftReviewComments: readonly DraftReviewComment[]
  /** Open submit-review approval, if any. */
  readonly pendingReviewApprovalId?: string
  /** The summary and verdict the reviewer proposed when it asked to submit. */
  readonly reviewProposal?: { readonly summary?: string; readonly verdict?: ReviewVerdict }
  /** What became of the last review that was sent to GitHub. */
  readonly reviewOutcome?:
    | {
        readonly status: 'submitted'
        readonly verdict: ReviewVerdict
        readonly commentCount: number
        /** Comments GitHub could not place on a line, sent in the review's body instead. */
        readonly unanchoredCount: number
      }
    | { readonly status: 'failed'; readonly error: string }
  /** Threads run by a vendor agent (Codex, Claude Code), keyed by thread id. */
  readonly vendorAgents: Readonly<Record<string, VendorAgent>>
}

export interface VendorAgent {
  readonly harness: string
  readonly label: string
  readonly model?: string
  /** The person whose subscription the agent is running on. */
  readonly billedTo?: string
}

export interface MessageAuthor {
  readonly id: string
  readonly name: string
}

const MessageAuthorSchema = z.object({ id: z.string(), name: z.string() })

/** Who sent a message, when the payload says. */
function messageAuthor(value: JsonValue | undefined): MessageAuthor | undefined {
  const author = MessageAuthorSchema.safeParse(value)

  return author.success ? { id: author.data.id, name: author.data.name } : undefined
}

export interface PlaybookLessonRef {
  readonly id: string
  readonly text: string
  readonly scope?: string
}

const initialFeed: SessionFeed = {
  media: [],
  publishedPulls: [],
  draftReviewComments: [],
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
  pendingThoughts: {},
  openTurns: {},
  queued: {},
  vendorAgents: {},
}

function withoutKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([entryKey]) => entryKey !== key))
}

type PublishOutcome = NonNullable<Extract<FeedItem, { kind: 'question' }>['publish']>

function schemaDefaults(schema: JsonValue | undefined): JsonObject {
  const properties = jsonFields(jsonFields(schema).properties)
  const defaults: Record<string, JsonValue> = {}

  for (const [key, property] of Object.entries(properties)) {
    const value = jsonFields(property).default

    if (value !== undefined) {
      defaults[key] = value
    }
  }

  return defaults
}

function withPublishOutcome(
  feed: SessionFeed,
  index: number | undefined,
  publish: PublishOutcome,
): SessionFeed {
  const question = index === undefined ? undefined : feed.items[index]

  if (index === undefined || question?.kind !== 'question') {
    return feed
  }

  const items = [...feed.items]
  items[index] = { ...question, publish }
  return { ...feed, items }
}

function appendItem(feed: SessionFeed, item: FeedItem): SessionFeed {
  return { ...feed, items: [...feed.items, item] }
}

interface TakenThought {
  readonly feed: SessionFeed
  readonly thought?: ThoughtInfo
}

function takePendingThought(feed: SessionFeed, threadId: string, turn?: number): TakenThought {
  const pending = feed.pendingThoughts[threadId]

  if (!pending || (turn !== undefined && pending.turn !== turn)) {
    return { feed }
  }

  return {
    feed: { ...feed, pendingThoughts: withoutKey(feed.pendingThoughts, threadId) },
    thought: pending,
  }
}

/** Flush an unclaimed thought when a turn settles without messages, tools, or approvals. */
function flushPendingThought(feed: SessionFeed, threadId: string | null | undefined): SessionFeed {
  if (!hasText(threadId)) {
    return feed
  }

  const pending = feed.pendingThoughts[threadId]

  if (!pending) {
    return feed
  }

  const cleared: SessionFeed = {
    ...feed,
    pendingThoughts: withoutKey(feed.pendingThoughts, threadId),
  }

  const last = cleared.items.at(-1)

  if (last?.kind === 'tools' && last.threadId === threadId) {
    const items = [...cleared.items]

    items[items.length - 1] = {
      ...last,
      thoughts: [...last.thoughts, pending],
      steps: [...last.steps, { kind: 'thought', thought: pending }],
    }

    return { ...cleared, items }
  }

  return appendItem(cleared, {
    kind: 'thought',
    id: pending.id,
    seq: pending.seq,
    ts: pending.ts,
    threadId,
    turn: pending.turn,
    text: pending.text,
    durationMs: pending.durationMs,
  })
}

/** Looms runs each model turn of a thread as the effect `<threadId>:llm_turn_<n>`. */
const MODEL_TURN_EFFECT = /^(.+):llm_turn_\d+$/

function mapValues<T, U>(
  record: Readonly<Record<string, T>>,
  map: (value: T) => U,
): Record<string, U> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, map(value)]))
}

/**
 * Ends a thread's turn. A turn is recorded when it ends, so messages sent while it ran would sit
 * above what it did. The agent reads them next, so they move below it.
 */
function endTurn(feed: SessionFeed, threadId: string | null | undefined): SessionFeed {
  if (!hasText(threadId) || feed.openTurns[threadId] === undefined) {
    return feed
  }

  const ended: SessionFeed = { ...feed, openTurns: withoutKey(feed.openTurns, threadId) }

  const waiting = new Set(
    Object.entries(feed.queued).flatMap(([messageId, waitsFor]) =>
      waitsFor === threadId ? [messageId] : [],
    ),
  )

  if (waiting.size === 0) {
    return ended
  }

  const isWaiting = (item: FeedItem) => item.kind === 'user' && waiting.has(item.messageId)
  const items = [...feed.items.filter((item) => !isWaiting(item)), ...feed.items.filter(isWaiting)]
  const position = new Map(items.map((item, index) => [item, index]))

  const moved = (index: number) => {
    const item = feed.items[index]
    return (item && position.get(item)) ?? index
  }

  return {
    ...ended,
    items,
    queued: Object.fromEntries(
      Object.entries(feed.queued).filter(([messageId]) => !waiting.has(messageId)),
    ),
    toolIndex: mapValues(feed.toolIndex, moved),
    questionIndex: mapValues(feed.questionIndex, moved),
  }
}

function onToolCall(feed: SessionFeed, event: SessionEvent): SessionFeed {
  const payload = eventFields(event)
  const call = jsonFields(payload.toolCall)
  const toolCallId = jsonText(call.id)
  const threadId = event.threadId

  const name = jsonText(call.name) ?? 'tool'

  // `ask_user` surfaces as a question card from its approval gate instead.
  if (
    !hasText(toolCallId) ||
    !hasText(threadId) ||
    name === 'ask_user' ||
    feed.toolIndex[toolCallId] !== undefined
  ) {
    return feed
  }

  const turn = jsonNumber(payload.turn)
  const taken = takePendingThought(feed, threadId, turn)
  const baseFeed = taken.feed
  const thought = taken.thought

  const item: ToolCallItem = {
    toolCallId,
    name,
    args: call.arguments ?? null,
    seq: event.seq,
    status: 'running',
    startedAt: event.ts,
  }

  const newSteps: ActivityStep[] = thought
    ? [
        { kind: 'thought', thought },
        { kind: 'call', call: item },
      ]
    : [{ kind: 'call', call: item }]

  const last = baseFeed.items.at(-1)

  // Consecutive silent work from one agent collapses into a single activity card.
  if (last?.kind === 'tools' && last.threadId === threadId) {
    const index = baseFeed.items.length - 1
    const items = [...baseFeed.items]

    items[index] = {
      ...last,
      calls: [...last.calls, item],
      thoughts: thought ? [...last.thoughts, thought] : last.thoughts,
      steps: [...last.steps, ...newSteps],
    }

    return { ...baseFeed, items, toolIndex: { ...baseFeed.toolIndex, [toolCallId]: index } }
  }

  return {
    ...appendItem(baseFeed, {
      kind: 'tools',
      id: event.id,
      seq: event.seq,
      ts: event.ts,
      threadId,
      calls: [item],
      thoughts: thought ? [thought] : [],
      steps: newSteps,
    }),
    toolIndex: { ...baseFeed.toolIndex, [toolCallId]: baseFeed.items.length },
  }
}

function onToolResult(feed: SessionFeed, event: SessionEvent): SessionFeed {
  const payload = eventFields(event)
  const toolCallId = jsonText(payload.toolCallId)
  const index = hasText(toolCallId) ? feed.toolIndex[toolCallId] : undefined
  const group = index === undefined ? undefined : feed.items[index]

  if (index === undefined || group?.kind !== 'tools') {
    return feed
  }

  const error = jsonText(payload.error) ?? undefined
  const items = [...feed.items]

  const updateCall = (call: ToolCallItem): ToolCallItem =>
    call.toolCallId === toolCallId
      ? {
          ...call,
          status: hasText(error) ? 'error' : 'ok',
          result: payload.result ?? null,
          error,
        }
      : call

  items[index] = {
    ...group,
    calls: group.calls.map(updateCall),
    steps: group.steps.map((step) =>
      step.kind === 'call' ? { kind: 'call', call: updateCall(step.call) } : step,
    ),
  }

  const call = group.calls.find((candidate) => candidate.toolCallId === toolCallId)

  const shared =
    call?.name === SHARE_FILE_TOOL && !hasText(error) ? sharedAssetOf(payload.result) : undefined

  return shared
    ? withSharedMedia({ ...feed, items }, event, group.threadId, shared)
    : { ...feed, items }
}

/** The tool an agent calls to show a file. Its result carries the file. */
const SHARE_FILE_TOOL = 'share_file'

/** Shows a file an agent shared. Files shared one after another by one agent share a row. */
function withSharedMedia(
  feed: SessionFeed,
  event: SessionEvent,
  threadId: string,
  asset: MediaAsset,
): SessionFeed {
  const media = [
    ...feed.media,
    { asset, source: 'agent' as const, seq: event.seq, ts: event.ts, threadId },
  ]

  // Each share is a tool call of its own, so the row for the previous file sits just behind the
  // calls that shared the later ones.
  const isShareCalls = (item: FeedItem) =>
    item.kind === 'tools' &&
    item.threadId === threadId &&
    item.calls.every((call) => call.name === SHARE_FILE_TOOL)

  const index = feed.items.findLastIndex((item) => !isShareCalls(item))
  const previous = feed.items[index]

  if (previous?.kind === 'media' && previous.threadId === threadId) {
    const items = [...feed.items]

    items[index] = { ...previous, assets: [...previous.assets, asset] }

    return { ...feed, media, items }
  }

  return {
    ...appendItem(feed, {
      kind: 'media',
      id: event.id,
      seq: event.seq,
      ts: event.ts,
      threadId,
      assets: [asset],
    }),
    media,
  }
}

function reduceFeed(feed: SessionFeed, event: SessionEvent): SessionFeed {
  const payload = eventFields(event)

  switch (event.type) {
    case 'runtime.thread.started': {
      if (hasText(feed.rootThreadId) || hasText(event.parentThreadId)) {
        return feed
      }

      const goal = jsonText(jsonFields(payload.input).goal)
      const attachments = mediaAssetsOf(jsonFields(payload.input).attachments)

      if (!hasText(goal) || !hasText(event.threadId)) {
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
          attachments: attachments.length > 0 ? attachments : undefined,
        }),
        media: [
          ...feed.media,
          ...attachments.map((asset) => ({
            asset,
            source: 'upload' as const,
            seq: event.seq,
            ts: event.ts,
          })),
        ],
        rootThreadId: event.threadId,
        brief: [{ version: 1, text: goal, ts: event.ts }],
      }
    }

    case 'shuttle.user.said': {
      const messageId = jsonText(payload.messageId)
      const text = jsonText(payload.text) ?? ''
      const attachments = mediaAssetsOf(payload.attachments)
      const references = mentionReferencesOf(payload.references)

      // A message may be files alone.
      if (!hasText(messageId) || (!hasText(text) && attachments.length === 0)) {
        return feed
      }

      const forced = jsonText(payload.forceKind)
      const author = messageAuthor(payload.author)

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
          author,
          attachments: attachments.length > 0 ? attachments : undefined,
          references: references.length > 0 ? references : undefined,
        }),
        messageText: { ...feed.messageText, [messageId]: text },
        media: [
          ...feed.media,
          ...attachments.map((asset) => ({
            asset,
            source: 'upload' as const,
            seq: event.seq,
            ts: event.ts,
            authorName: author?.name,
          })),
        ],
      }
    }

    case 'shuttle.intake.started': {
      const messageId = jsonText(payload.messageId)
      return hasText(messageId)
        ? { ...feed, classifying: { ...feed.classifying, [messageId]: true } }
        : feed
    }

    case 'shuttle.routed': {
      const messageId = jsonText(payload.messageId)
      const kind = jsonText(payload.kind)

      if (!hasText(messageId) || !isInterjectionKind(kind)) {
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

      if (!hasText(messageId) || !hasText(childThreadId)) {
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
            return hasText(id) && hasText(text) ? [{ id, text, scope: jsonText(fields.scope) }] : []
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

      const reasonLabel = hasText(reason) && reason !== 'initial' ? ` after ${reason}` : ''

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

      if (!hasText(runId)) {
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

      if (!hasText(messageId) || !hasText(event.threadId)) {
        return feed
      }

      const delivery: RouteDelivery = {
        threadId: event.threadId,
        interrupt: payload.interrupt === true,
      }

      const waits = !delivery.interrupt && feed.openTurns[event.threadId] === true

      return {
        ...feed,
        deliveries: {
          ...feed.deliveries,
          [messageId]: [...(feed.deliveries[messageId] ?? []), delivery],
        },
        queued:
          waits && feed.queued[messageId] === undefined
            ? { ...feed.queued, [messageId]: event.threadId }
            : feed.queued,
      }
    }

    case 'runtime.effect.attempt.started': {
      const threadId = MODEL_TURN_EFFECT.exec(jsonText(payload.effectId) ?? '')?.[1]

      return hasText(threadId) && feed.openTurns[threadId] === undefined
        ? { ...feed, openTurns: { ...feed.openTurns, [threadId]: true } }
        : feed
    }

    case 'shuttle.turn.thought': {
      const text = jsonText(payload.text)?.trim()
      const turn = jsonNumber(payload.turn)

      if (!hasText(text) || turn === undefined || !hasText(event.threadId)) {
        return feed
      }

      const flushed = flushPendingThought(feed, event.threadId)

      return {
        ...flushed,
        pendingThoughts: {
          ...flushed.pendingThoughts,
          [event.threadId]: {
            id: event.id,
            text,
            durationMs: jsonNumber(payload.durationMs),
            seq: event.seq,
            ts: event.ts,
            turn,
          },
        },
      }
    }

    case 'shuttle.sandbox.moved': {
      const machine = jsonText(payload.device) ?? 'a local machine'
      const place = (end: JsonValue | undefined) => (end === 'local' ? machine : 'the cloud')

      return appendItem(feed, {
        kind: 'notice',
        id: event.id,
        seq: event.seq,
        ts: event.ts,
        tone: 'info',
        text:
          payload.fromSave === true
            ? `Moved from ${place(payload.from)} to ${place(payload.to)} using its last save, because ${machine} was not connected. Anything changed there since is still on it.`
            : `Moved from ${place(payload.from)} to ${place(payload.to)}, with its branches and uncommitted files.`,
      })
    }

    case 'shuttle.team.changed': {
      const members = [
        payload.workers === true ? 'Shuttle workers' : null,
        payload.codex === true ? 'Codex' : null,
        payload.claudeCode === true ? 'Claude Code' : null,
        payload.cursor === true ? 'Cursor' : null,
      ].filter(Boolean)

      return appendItem(feed, {
        kind: 'notice',
        id: event.id,
        seq: event.seq,
        ts: event.ts,
        tone: 'info',
        text: `Team is now ${members.join(', ')}. This applies from the conductor's next turn.`,
      })
    }

    case 'shuttle.vendor.turn_started': {
      const label = jsonText(payload.label)
      const harness = jsonText(payload.harness)

      if (!hasText(label) || !hasText(harness) || !hasText(event.threadId)) {
        return feed
      }

      const model = jsonText(payload.model)
      const billedTo = jsonText(payload.billedTo)

      return {
        ...feed,
        vendorAgents: {
          ...feed.vendorAgents,
          [event.threadId]: {
            harness,
            label,
            model: hasText(model) ? model : undefined,
            billedTo: hasText(billedTo) ? billedTo : undefined,
          },
        },
      }
    }

    // A vendor agent says several things in one turn. Each is its own message in the feed.
    case 'shuttle.vendor.message': {
      const text = jsonText(payload.text)?.trim()

      if (!hasText(text) || !hasText(event.threadId)) {
        return feed
      }

      const taken = takePendingThought(feed, event.threadId, jsonNumber(payload.turn))

      return appendItem(taken.feed, {
        kind: 'agent',
        id: event.id,
        seq: event.seq,
        ts: event.ts,
        threadId: event.threadId,
        text,
        replyTo: taken.feed.narrators[event.threadId],
        thought: taken.thought,
      })
    }

    case 'agent.message': {
      const message = jsonFields(payload.message)
      const text = jsonText(message.content)?.trim()

      if (message.role !== 'assistant' || !hasText(text) || !hasText(event.threadId)) {
        return feed
      }

      const turn = jsonNumber(payload.turn)
      const taken = takePendingThought(feed, event.threadId, turn)

      return appendItem(taken.feed, {
        kind: 'agent',
        id: event.id,
        seq: event.seq,
        ts: event.ts,
        threadId: event.threadId,
        text,
        replyTo: taken.feed.narrators[event.threadId],
        thought: taken.thought,
      })
    }

    case 'agent.tool_call.requested':
    // A vendor agent's own tools are recorded in the same shape as Shuttle's.
    case 'shuttle.vendor.tool_started':
      return onToolCall(feed, event)

    case 'approval.requested': {
      const approvalId = jsonText(payload.approvalId)

      if (
        !hasText(approvalId) ||
        !hasText(event.threadId) ||
        feed.questionIndex[approvalId] !== undefined
      ) {
        return feed
      }

      const taken = takePendingThought(feed, event.threadId)
      const defaults = schemaDefaults(payload.schema)

      const asked: SessionFeed = {
        ...appendItem(taken.feed, {
          kind: 'question',
          id: event.id,
          seq: event.seq,
          ts: event.ts,
          threadId: event.threadId,
          approvalId,
          title: jsonText(payload.title) ?? 'The agent needs your input',
          defaults: Object.keys(defaults).length > 0 ? defaults : undefined,
          thought: taken.thought,
        }),
        questionIndex: { ...taken.feed.questionIndex, [approvalId]: taken.feed.items.length },
      }

      if (!approvalId.startsWith('pr_review_')) {
        return asked
      }

      const summary = jsonText(defaults.summary)

      return {
        ...asked,
        pendingReviewApprovalId: approvalId,
        reviewOutcome: undefined,
        reviewProposal: {
          summary: hasText(summary) ? summary : undefined,
          verdict: reviewVerdict(defaults.verdict),
        },
      }
    }

    case 'shuttle.review.submitted': {
      return {
        ...feed,
        reviewOutcome: {
          status: 'submitted',
          verdict: reviewVerdict(payload.verdict) ?? 'comment',
          commentCount: jsonNumber(payload.commentCount) ?? 0,
          unanchoredCount: jsonNumber(payload.unanchoredCount) ?? 0,
        },
      }
    }

    case 'shuttle.review.submit_failed': {
      return {
        ...feed,
        reviewOutcome: {
          status: 'failed',
          error: jsonText(payload.error) ?? 'The review could not be sent.',
        },
      }
    }

    case 'approval.decided': {
      const approvalId = jsonText(payload.approvalId)
      const index = hasText(approvalId) ? feed.questionIndex[approvalId] : undefined
      const question = index === undefined ? undefined : feed.items[index]

      if (index === undefined || question?.kind !== 'question') {
        return feed
      }

      const answer =
        payload.outcome === 'approve'
          ? (jsonText(jsonFields(payload.payload).answer) ?? 'Approved')
          : null

      const items = [...feed.items]
      items[index] = { ...question, decision: { answer, ts: event.ts } }

      return {
        ...feed,
        items,
        pendingReviewApprovalId:
          hasText(approvalId) && approvalId === feed.pendingReviewApprovalId
            ? undefined
            : feed.pendingReviewApprovalId,
      }
    }

    case 'shuttle.pr.published': {
      const pullsRaw = Array.isArray(payload.pulls) ? payload.pulls : []
      const approvalId = jsonText(payload.approvalId)
      const index = hasText(approvalId) ? feed.questionIndex[approvalId] : undefined
      const question = index === undefined ? undefined : feed.items[index]
      const proposedBy = question?.kind === 'question' ? question.threadId : undefined
      const threadId = jsonText(payload.threadId) ?? proposedBy
      const stackId = jsonNumber(payload.stackId) ?? 1

      const published = pullsRaw.flatMap((entry) => {
        const pull = jsonFields(entry)
        const fullName = jsonText(pull.fullName)
        const number = jsonNumber(pull.number)
        const url = jsonText(pull.url)
        const layer = jsonNumber(pull.layer)
        const outcome = jsonText(pull.outcome)

        if (!hasText(fullName) || number === undefined || !hasText(url)) {
          return []
        }

        return [
          {
            fullName,
            number,
            url,
            draft: pull.draft === true,
            outcome: publishOutcome(outcome),
            threadId: hasText(threadId) ? threadId : undefined,
            stack: layer === undefined ? undefined : { id: stackId, layer },
          } satisfies PublishedPull,
        ]
      })

      if (published.length === 0) {
        return feed
      }

      return {
        ...withPublishOutcome(feed, index, { status: 'published', pulls: published }),
        publishedPulls: [...feed.publishedPulls, ...published],
      }
    }

    case 'shuttle.pr.publish_failed': {
      const approvalId = jsonText(payload.approvalId)
      const index = hasText(approvalId) ? feed.questionIndex[approvalId] : undefined

      return withPublishOutcome(feed, index, {
        status: 'failed',
        error: jsonText(payload.error) ?? 'Publishing failed',
      })
    }

    case 'shuttle.review.comment.drafted': {
      const commentId = jsonText(payload.commentId)
      const path = jsonText(payload.path)
      const line = jsonNumber(payload.line)
      const body = jsonText(payload.body)

      if (!hasText(commentId) || !hasText(path) || line === undefined || !hasText(body)) {
        return feed
      }

      const severityRaw = jsonText(payload.severity)

      const severity =
        severityRaw === 'warning' || severityRaw === 'error' ? severityRaw : ('info' as const)

      const side = payload.side === 'LEFT' ? ('LEFT' as const) : ('RIGHT' as const)
      const suggestion = jsonText(payload.suggestion)

      return {
        ...feed,
        draftReviewComments: [
          ...feed.draftReviewComments.filter((comment) => comment.commentId !== commentId),
          {
            commentId,
            path,
            line,
            side,
            severity,
            body,
            suggestion: hasText(suggestion) ? suggestion : undefined,
          },
        ],
      }
    }

    case 'agent.tool.result':
    case 'shuttle.vendor.tool_finished':
      return onToolResult(feed, event)

    case 'agent.turn.settled':
    case 'runtime.thread.completed':
    case 'runtime.thread.cancelled':
      return endTurn(flushPendingThought(feed, event.threadId), event.threadId)

    case 'runtime.thread.failed':
      return endTurn(
        appendItem(flushPendingThought(feed, event.threadId), {
          kind: 'notice',
          id: event.id,
          seq: event.seq,
          ts: event.ts,
          tone: 'error',
          text: jsonText(payload.error) ?? 'Thread failed',
          threadId: event.threadId ?? undefined,
        }),
        event.threadId,
      )

    case 'agent.turn.stopped':
      return endTurn(
        appendItem(flushPendingThought(feed, event.threadId), {
          kind: 'notice',
          id: event.id,
          seq: event.seq,
          ts: event.ts,
          tone: 'info',
          text: 'Stopped',
          threadId: event.threadId ?? undefined,
        }),
        event.threadId,
      )

    default:
      return feed
  }
}

export const sessionFeed: ProjectionDefinition<SessionFeed> = {
  name: 'shuttleSessionFeed',
  initialState: initialFeed,
  // Live copies of a vendor agent's steps are folded by `vendorLiveFeed`; the durable copies
  // that arrive with the turn's result are the ones that belong here.
  reduce: (feed, event) => (event.ephemeral === true ? feed : reduceFeed(feed, event)),
}

const VENDOR_STEP_TYPES = new Set([
  'shuttle.vendor.turn_started',
  'shuttle.vendor.message',
  'shuttle.vendor.tool_started',
  'shuttle.vendor.tool_finished',
  'shuttle.turn.thought',
])

const TURN_ENDED_TYPES = new Set([
  'agent.message',
  'agent.turn.settled',
  'agent.turn.stopped',
  'runtime.thread.completed',
  'runtime.thread.failed',
  'runtime.thread.cancelled',
])

/**
 * What each vendor agent has done so far in a turn that is still running, as a small feed per
 * thread. A vendor turn's steps only become durable when the turn ends, so this is what shows
 * the agent working in the meantime. It empties for a thread once that turn's result lands.
 */
export const vendorLiveFeed: LiveFoldDefinition<
  Readonly<Record<string, SessionFeed>>,
  SessionEvent
> = {
  kind: 'liveFold',
  name: 'shuttleVendorLiveFeed',
  initialState: {},
  reduce(state, event) {
    const threadId = event.threadId

    if (!hasText(threadId)) {
      return state
    }

    if (event.ephemeral === true && VENDOR_STEP_TYPES.has(event.type)) {
      return { ...state, [threadId]: reduceFeed(state[threadId] ?? initialFeed, event) }
    }

    const durableStep = event.ephemeral !== true && VENDOR_STEP_TYPES.has(event.type)

    if ((durableStep || TURN_ENDED_TYPES.has(event.type)) && threadId in state) {
      return withoutKey(state, threadId)
    }

    return state
  },
}

/** The durable feed with every running vendor turn's steps so far appended. */
export function withLiveVendorSteps(
  feed: SessionFeed,
  live: Readonly<Record<string, SessionFeed>>,
): SessionFeed {
  const threads = Object.entries(live)

  if (threads.length === 0) {
    return feed
  }

  let items = feed.items
  let vendorAgents = feed.vendorAgents

  for (const [threadId, steps] of threads) {
    // A thought with nothing after it yet still shows, as its own row.
    items = [...items, ...flushPendingThought(steps, threadId).items]
    vendorAgents = { ...vendorAgents, ...steps.vendorAgents }
  }

  return { ...feed, items, vendorAgents }
}

export interface StreamingTurn {
  readonly turn: number
  readonly thinking: string
  readonly text: string
  readonly thinkingStartedAt?: number
  readonly thinkingEndedAt?: number
}

function clearStreamingTurn(
  state: Readonly<Record<string, StreamingTurn>>,
  threadId: string,
): Readonly<Record<string, StreamingTurn>> {
  return threadId in state ? withoutKey(state, threadId) : state
}

/** Live thinking + reply text each agent has streamed since its last durable message. */
export const streamingTurns: LiveFoldDefinition<
  Readonly<Record<string, StreamingTurn>>,
  SessionEvent
> = {
  kind: 'liveFold',
  name: 'shuttleStreamingTurns',
  initialState: {},
  reduce(state, event) {
    const threadId = event.threadId

    if (!hasText(threadId)) {
      return state
    }

    if (
      event.type === 'agent.message' ||
      event.type === 'agent.turn.settled' ||
      event.type === 'agent.turn.stopped' ||
      event.type === 'runtime.thread.completed' ||
      event.type === 'runtime.thread.failed' ||
      event.type === 'runtime.thread.cancelled'
    ) {
      return clearStreamingTurn(state, threadId)
    }

    const payload = eventFields(event)
    const turn = jsonNumber(payload.turn) ?? state[threadId]?.turn ?? 0
    const current = state[threadId]

    // A vendor agent's turn has several messages and thoughts. Once one is recorded as a step,
    // it stops being streamed text and the next one starts from empty.
    if (current && event.ephemeral === true && event.type === 'shuttle.vendor.message') {
      return { ...state, [threadId]: { ...current, text: '' } }
    }

    if (current && event.ephemeral === true && event.type === 'shuttle.turn.thought') {
      return { ...state, [threadId]: { turn: current.turn, thinking: '', text: current.text } }
    }

    const base: StreamingTurn = current ?? {
      turn,
      thinking: '',
      text: '',
    }

    if (event.type === 'shuttle.turn.thinking_delta') {
      const delta = jsonText(payload.delta)

      if (!hasText(delta)) {
        return state
      }

      const nextTurn =
        current && current.turn !== turn
          ? { turn, thinking: '', text: '', thinkingStartedAt: event.ts }
          : base

      return {
        ...state,
        [threadId]: {
          ...nextTurn,
          turn,
          thinking: `${nextTurn.thinking}${delta}`,
          thinkingStartedAt: nextTurn.thinkingStartedAt ?? event.ts,
          thinkingEndedAt: event.ts,
        },
      }
    }

    if (event.type === 'agent.turn.text_delta') {
      const delta = jsonText(payload.delta)

      if (!hasText(delta)) {
        return state
      }

      const nextTurn = current && current.turn !== turn ? { turn, thinking: '', text: '' } : base

      return {
        ...state,
        [threadId]: {
          ...nextTurn,
          turn,
          text: `${nextTurn.text}${delta}`,
          thinkingEndedAt:
            nextTurn.thinking !== '' ? (nextTurn.thinkingEndedAt ?? event.ts) : undefined,
        },
      }
    }

    return state
  },
}

export function currentBrief(feed: SessionFeed): BriefRevision | undefined {
  return feed.brief.toSorted((left, right) => right.version - left.version)[0]
}

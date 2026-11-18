import { Schema } from 'effect'

import { isJsonObject, isJsonString } from '@swirls/looms/core'
import type { EventEnvelope, JsonObject, JsonValue } from '@swirls/looms/core'

import { shuttleModule } from './scope'

const WorkStatusSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('thinking') }),
  Schema.Struct({
    kind: Schema.Literal('tool'),
    name: Schema.String,
    shortArgs: Schema.String,
    startedAt: Schema.Finite,
  }),
  Schema.Struct({
    kind: Schema.Literal('waiting_on_children'),
    childThreadIds: Schema.Array(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal('done') }),
  Schema.Struct({
    kind: Schema.Literal('failed'),
    error: Schema.optional(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal('stopped') }),
])

const RecentToolCallSchema = Schema.Struct({
  name: Schema.String,
  exit: Schema.optional(Schema.Union([Schema.Literal('ok'), Schema.Literal('error')])),
  error: Schema.optional(Schema.String),
  durationMs: Schema.optional(Schema.Finite),
})

const WorkEntrySchema = Schema.Struct({
  threadId: Schema.String,
  label: Schema.String,
  role: Schema.Union([
    Schema.Literal('conductor'),
    Schema.Literal('worker'),
    Schema.Literal('narrator'),
  ]),
  task: Schema.optional(Schema.String),
  status: WorkStatusSchema,
  turnCount: Schema.Finite,
  turnsSinceWrite: Schema.Finite,
  lastThought: Schema.optional(Schema.String),
  recentToolCalls: Schema.Array(RecentToolCallSchema),
  recentArgSummaries: Schema.Array(Schema.String),
  filesWritten: Schema.Array(Schema.String),
  filesEdited: Schema.Array(Schema.String),
  stuckSignals: Schema.Array(Schema.String),
  /** Pending delegate children; cleared as they finish. */
  waitingChildren: Schema.Array(Schema.String),
})

const ToolCallMetaSchema = Schema.Struct({
  threadId: Schema.String,
  name: Schema.String,
  shortArgs: Schema.String,
  startedAt: Schema.Finite,
  taskText: Schema.optional(Schema.String),
})

export const workShape = Schema.Struct({
  entries: Schema.Array(WorkEntrySchema),
  nextWorkerIndex: Schema.Finite,
  openToolCalls: Schema.Record(Schema.String, ToolCallMetaSchema),
})

export type WorkProjectionState = typeof workShape.Type

type WorkEntry = (typeof WorkEntrySchema)['Type']
type RecentToolCall = (typeof RecentToolCallSchema)['Type']
type ToolCallMeta = (typeof ToolCallMetaSchema)['Type']
type WorkStatus = (typeof WorkStatusSchema)['Type']

export const workInitialState: WorkProjectionState = {
  entries: [],
  nextWorkerIndex: 1,
  openToolCalls: {},
}

function asRecord(value: JsonValue | undefined): JsonObject {
  return isJsonObject(value) ? value : {}
}

function asString(value: JsonValue | undefined): string | undefined {
  return isJsonString(value) ? value : undefined
}

/** True for a string that is neither missing nor empty. */
function isPresent(value: string | undefined | null): value is string {
  return value !== undefined && value !== null && value !== ''
}

function shortArgs(value: JsonValue | undefined): string {
  if (value === null || value === undefined) {
    return ''
  }

  if (isJsonString(value)) {
    return value.length > 120 ? `${value.slice(0, 117)}...` : value
  }

  try {
    const text = JSON.stringify(value)
    return text.length > 120 ? `${text.slice(0, 117)}...` : text
  } catch {
    return '[unserializable]'
  }
}

function normalizeArgs(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

function argsNearlySame(left: string, right: string): boolean {
  const a = normalizeArgs(left)
  const b = normalizeArgs(right)

  if (a === b) {
    return true
  }

  if (a.length > 20 && b.length > 20) {
    return a.slice(0, 48) === b.slice(0, 48)
  }

  return false
}

function taskFromDelegateArgs(args: JsonObject): string | undefined {
  const text = asString(args.text) ?? asString(args.task)

  if (isPresent(text)) {
    return text
  }

  return undefined
}

function pathFromToolResult(name: string, result: JsonValue | undefined): string | undefined {
  if (name !== 'write_file' && name !== 'edit_file') {
    return undefined
  }

  const record = asRecord(result)
  return asString(record.path)
}

function computeStuckSignals(entry: WorkEntry): string[] {
  const argTrail = entry.recentArgSummaries
  const signals: string[] = []

  if (entry.turnsSinceWrite >= 5) {
    signals.push(`turns_without_write:${entry.turnsSinceWrite}`)
  }

  if (argTrail.length >= 3) {
    const tail = argTrail.slice(-3)
    const first = tail[0] ?? ''

    if (tail.every((item) => argsNearlySame(item, first))) {
      const lastCall = entry.recentToolCalls.at(-1)
      signals.push(`repeated_tool_args:${lastCall?.name ?? 'tool'}`)
    }
  }

  const errors = entry.recentToolCalls.filter((call) => call.exit === 'error')

  if (errors.length >= 3) {
    const names = errors.slice(-3).map((call) => call.name)
    const sameName = names.every((name) => name === names[0])

    if (sameName) {
      signals.push(`repeated_tool_errors:${names[0]}`)
    }
  }

  return signals
}

function upsertEntry(
  state: WorkProjectionState,
  threadId: string,
  build: (existing: WorkEntry | undefined) => WorkEntry,
): WorkProjectionState {
  const index = state.entries.findIndex((entry) => entry.threadId === threadId)
  const next = build(index >= 0 ? state.entries[index] : undefined)
  const entries = [...state.entries]

  if (index >= 0) {
    entries[index] = next
  } else {
    entries.push(next)
  }

  return { ...state, entries }
}

function patchEntry(
  state: WorkProjectionState,
  threadId: string,
  patch: (entry: WorkEntry) => WorkEntry,
): WorkProjectionState {
  const existing = state.entries.find((entry) => entry.threadId === threadId)

  if (existing === undefined) {
    return state
  }

  return upsertEntry(state, threadId, () => patch(existing))
}

function defaultEntry(
  threadId: string,
  label: string,
  role: WorkEntry['role'],
  task?: string,
): WorkEntry {
  return {
    threadId,
    label,
    role,
    task,
    status: { kind: 'thinking' },
    turnCount: 0,
    turnsSinceWrite: 0,
    recentToolCalls: [],
    recentArgSummaries: [],
    filesWritten: [],
    filesEdited: [],
    stuckSignals: [],
    waitingChildren: [],
  }
}

function appendRecentToolCall(
  entry: WorkEntry,
  call: WorkEntry['recentToolCalls'][number],
): WorkEntry {
  const recentToolCalls = [...entry.recentToolCalls, call].slice(-5)
  const next = { ...entry, recentToolCalls }

  return {
    ...next,
    stuckSignals: computeStuckSignals(next),
  }
}

function childStatusForParent(state: WorkProjectionState, entry: WorkEntry): WorkStatus {
  if (entry.waitingChildren.length > 0) {
    return { kind: 'waiting_on_children', childThreadIds: [...entry.waitingChildren] }
  }

  const openForThread = Object.entries(state.openToolCalls).find(
    ([, info]) => info.threadId === entry.threadId,
  )

  if (openForThread !== undefined) {
    const [, info] = openForThread
    return {
      kind: 'tool',
      name: info.name,
      shortArgs: info.shortArgs,
      startedAt: info.startedAt,
    }
  }

  if (
    entry.status.kind === 'done' ||
    entry.status.kind === 'failed' ||
    entry.status.kind === 'stopped'
  ) {
    return entry.status
  }

  return { kind: 'thinking' }
}

type DefinitionLabel = {
  readonly label: string
  readonly role: WorkEntry['role']
  readonly nextWorkerIndex: number
}

function labelForDefinition(
  definitionName: string | undefined,
  state: WorkProjectionState,
): DefinitionLabel {
  if (definitionName === 'conductor') {
    return { label: 'conductor', role: 'conductor', nextWorkerIndex: state.nextWorkerIndex }
  }

  if (definitionName === 'narrator') {
    return { label: 'narrator', role: 'narrator', nextWorkerIndex: state.nextWorkerIndex }
  }

  if (definitionName === 'worker') {
    const index = state.nextWorkerIndex
    return { label: `worker ${index}`, role: 'worker', nextWorkerIndex: index + 1 }
  }

  return {
    label: definitionName ?? 'agent',
    role: 'worker',
    nextWorkerIndex: state.nextWorkerIndex,
  }
}

function reduceWork(state: WorkProjectionState, event: EventEnvelope): WorkProjectionState {
  const threadId = asString(event.threadId)
  const payload = asRecord(event.payload)

  switch (event.type) {
    case 'runtime.thread.started': {
      const startedThreadId = asString(payload.threadId) ?? threadId

      if (!isPresent(startedThreadId)) {
        return state
      }

      const kind = asString(payload.kind)
      const definitionName = asString(payload.definitionName)

      if (kind !== 'agent') {
        return state
      }

      if (definitionName === 'narrator') {
        return upsertEntry(
          state,
          startedThreadId,
          (existing) =>
            existing ??
            defaultEntry(
              startedThreadId,
              'narrator',
              'narrator',
              asString(asRecord(payload.input).text),
            ),
        )
      }

      const input = asRecord(payload.input)
      const task = asString(input.text) ?? asString(input.goal)
      const existing = state.entries.find((entry) => entry.threadId === startedThreadId)

      if (existing !== undefined) {
        return upsertEntry(state, startedThreadId, () => {
          if (isPresent(task) && !isPresent(existing.task)) {
            return { ...existing, task }
          }

          return { ...existing }
        })
      }

      const { label, role, nextWorkerIndex } = labelForDefinition(definitionName, state)

      return {
        ...upsertEntry(state, startedThreadId, () =>
          defaultEntry(startedThreadId, label, role, task),
        ),
        nextWorkerIndex: definitionName === 'worker' ? nextWorkerIndex : state.nextWorkerIndex,
      }
    }

    case 'agent.turn.started': {
      if (!isPresent(threadId)) {
        return state
      }

      return patchEntry(state, threadId, (entry) => ({
        ...entry,
        turnCount: entry.turnCount + 1,
        status: childStatusForParent(state, entry),
      }))
    }

    case 'agent.turn.settled':

    case 'agent.turn.completed': {
      if (!isPresent(threadId)) {
        return state
      }

      return patchEntry(state, threadId, (entry) => ({
        ...entry,
        turnsSinceWrite: entry.turnsSinceWrite + 1,
        status: childStatusForParent(state, entry),
        stuckSignals: computeStuckSignals({
          ...entry,
          turnsSinceWrite: entry.turnsSinceWrite + 1,
        }),
      }))
    }

    case 'agent.turn.stopped': {
      if (!isPresent(threadId)) {
        return state
      }

      return patchEntry(state, threadId, (entry) => ({
        ...entry,
        status: { kind: 'stopped' },
      }))
    }

    case 'shuttle.turn.thought': {
      if (!isPresent(threadId)) {
        return state
      }

      const text = asString(payload.text)?.trim()

      if (!isPresent(text)) {
        return state
      }

      return patchEntry(state, threadId, (entry) => ({
        ...entry,
        lastThought: text,
      }))
    }

    case 'agent.tool_call.requested': {
      if (!isPresent(threadId)) {
        return state
      }

      const toolCall = asRecord(payload.toolCall)
      const toolCallId = asString(toolCall.id) ?? `call_${event.seq}`
      const name = asString(toolCall.name) ?? 'tool'
      const args = toolCall.arguments
      const argsRecord = asRecord(args)
      const summary = shortArgs(args)
      const startedAt = event.ts
      // delegate, delegate_codex and delegate_claude all hand a task to a team member.
      const taskText = name.startsWith('delegate') ? taskFromDelegateArgs(argsRecord) : undefined

      const openCall: ToolCallMeta = isPresent(taskText)
        ? { threadId, name, shortArgs: summary, startedAt, taskText }
        : { threadId, name, shortArgs: summary, startedAt }

      const openToolCalls = {
        ...state.openToolCalls,
        [toolCallId]: openCall,
      }

      return {
        ...patchEntry({ ...state, openToolCalls }, threadId, (entry) => ({
          ...entry,
          recentArgSummaries: [...entry.recentArgSummaries, summary].slice(-5),
          status: {
            kind: 'tool',
            name,
            shortArgs: summary,
            startedAt,
          },
        })),
        openToolCalls,
      }
    }

    case 'agent.spawn.requested': {
      const parentThreadId = threadId
      const childThreadId = asString(payload.childThreadId)
      const toolCallId = asString(payload.toolCallId)

      if (!isPresent(parentThreadId) || !isPresent(childThreadId)) {
        return state
      }

      const meta = isPresent(toolCallId) ? state.openToolCalls[toolCallId] : undefined
      const childTask = meta?.taskText
      const hadChild = state.entries.some((entry) => entry.threadId === childThreadId)

      let next = patchEntry(state, parentThreadId, (entry) => ({
        ...entry,
        waitingChildren: [...new Set([...entry.waitingChildren, childThreadId])],
        status: {
          kind: 'waiting_on_children' as const,
          childThreadIds: [...new Set([...entry.waitingChildren, childThreadId])],
        },
      }))

      next = upsertEntry(next, childThreadId, (existing) => {
        if (existing) {
          return isPresent(childTask) && !isPresent(existing.task)
            ? { ...existing, task: childTask }
            : existing
        }

        const workerIndex = next.nextWorkerIndex
        return defaultEntry(childThreadId, `worker ${workerIndex}`, 'worker', childTask)
      })

      if (!hadChild) {
        next = {
          ...next,
          nextWorkerIndex: next.nextWorkerIndex + 1,
        }
      }

      return next
    }

    case 'agent.tool.result': {
      const parentThreadId = threadId
      const toolCallId = asString(payload.toolCallId)
      const name = asString(payload.name) ?? 'tool'
      const error = asString(payload.error)
      const result = payload.result
      const meta = isPresent(toolCallId) ? state.openToolCalls[toolCallId] : undefined
      const startedAt = meta?.startedAt ?? event.ts
      const durationMs = Math.max(0, event.ts - startedAt)

      const openToolCalls = { ...state.openToolCalls }

      if (isPresent(toolCallId)) {
        delete openToolCalls[toolCallId]
      }

      if (!isPresent(parentThreadId)) {
        return { ...state, openToolCalls }
      }

      const path = !isPresent(error) ? pathFromToolResult(name, result) : undefined

      return patchEntry({ ...state, openToolCalls }, parentThreadId, (entry) => {
        const call: RecentToolCall = isPresent(error)
          ? { name, exit: 'error', error, durationMs }
          : { name, exit: 'ok', durationMs }

        let next = appendRecentToolCall(entry, call)

        if (isPresent(path) && name === 'write_file') {
          next = {
            ...next,
            filesWritten: [...new Set([...next.filesWritten, path])],
            turnsSinceWrite: 0,
            stuckSignals: computeStuckSignals({ ...next, turnsSinceWrite: 0 }),
          }
        }

        if (isPresent(path) && name === 'edit_file') {
          next = {
            ...next,
            filesEdited: [...new Set([...next.filesEdited, path])],
            turnsSinceWrite: 0,
            stuckSignals: computeStuckSignals({ ...next, turnsSinceWrite: 0 }),
          }
        }

        return {
          ...next,
          status: childStatusForParent({ ...state, openToolCalls }, next),
        }
      })
    }

    case 'runtime.thread.completed': {
      const finishedId = asString(payload.threadId) ?? threadId

      if (!isPresent(finishedId)) {
        return state
      }

      let next = patchEntry(state, finishedId, (entry) => ({
        ...entry,
        status: { kind: 'done' },
        waitingChildren: [],
      }))

      for (const entry of next.entries) {
        if (!entry.waitingChildren.includes(finishedId)) {
          continue
        }

        const waitingChildren = entry.waitingChildren.filter((id) => id !== finishedId)

        const patched: WorkEntry = {
          ...entry,
          waitingChildren,
          status:
            waitingChildren.length > 0
              ? { kind: 'waiting_on_children', childThreadIds: waitingChildren }
              : childStatusForParent(next, { ...entry, waitingChildren }),
        }

        next = upsertEntry(next, entry.threadId, () => patched)
      }

      return next
    }

    case 'runtime.thread.failed': {
      const failedId = asString(payload.threadId) ?? threadId

      if (!isPresent(failedId)) {
        return state
      }

      const error = asString(payload.error)

      let next = patchEntry(state, failedId, (entry) => {
        const status: WorkStatus = isPresent(error) ? { kind: 'failed', error } : { kind: 'failed' }

        return { ...entry, status, waitingChildren: [] }
      })

      for (const entry of next.entries) {
        if (!entry.waitingChildren.includes(failedId)) {
          continue
        }

        const waitingChildren = entry.waitingChildren.filter((id) => id !== failedId)

        next = upsertEntry(next, entry.threadId, () => ({
          ...entry,
          waitingChildren,
          status:
            waitingChildren.length > 0
              ? { kind: 'waiting_on_children', childThreadIds: waitingChildren }
              : childStatusForParent(next, { ...entry, waitingChildren }),
        }))
      }

      return next
    }

    case 'runtime.thread.cancelled': {
      const cancelledId = asString(payload.threadId) ?? threadId

      if (!isPresent(cancelledId)) {
        return state
      }

      let next = patchEntry(state, cancelledId, (entry) => ({
        ...entry,
        status: { kind: 'stopped' },
        waitingChildren: [],
      }))

      for (const entry of next.entries) {
        if (!entry.waitingChildren.includes(cancelledId)) {
          continue
        }

        const waitingChildren = entry.waitingChildren.filter((id) => id !== cancelledId)

        next = upsertEntry(next, entry.threadId, () => ({
          ...entry,
          waitingChildren,
          status:
            waitingChildren.length > 0
              ? { kind: 'waiting_on_children', childThreadIds: waitingChildren }
              : childStatusForParent(next, { ...entry, waitingChildren }),
        }))
      }

      return next
    }

    default:
      return state
  }
}

/** Public entries omit internal bookkeeping used only by the reducer. */
export type WorkAgentSnapshot = Omit<WorkEntry, 'waitingChildren' | 'recentArgSummaries'> & {
  readonly toolElapsedMs?: number
  readonly stuckSignals: readonly string[]
}

export function workAgentsForRead(state: WorkProjectionState, now: number): WorkAgentSnapshot[] {
  const longRunningMs = 60_000

  return state.entries.map((entry) => {
    const { waitingChildren, recentArgSummaries, stuckSignals, status, ...rest } = entry
    void waitingChildren
    void recentArgSummaries

    const signals = [...stuckSignals]

    if (status.kind === 'tool') {
      const elapsed = Math.max(0, now - status.startedAt)

      if (elapsed >= longRunningMs) {
        signals.push(`long_running_tool:${status.name}`)
      }
    }

    if (status.kind === 'tool') {
      return {
        ...rest,
        status,
        stuckSignals: signals,
        toolElapsedMs: Math.max(0, now - status.startedAt),
      }
    }

    return { ...rest, status, stuckSignals: signals }
  })
}

export const work = shuttleModule.projection({
  name: 'work',
  shape: workShape,
  initialState: workInitialState,
  reduce(state, event) {
    return reduceWork(state, event)
  },
})

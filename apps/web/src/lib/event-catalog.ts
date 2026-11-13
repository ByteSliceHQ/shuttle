import type { AnyEventEnvelope, JsonValue } from '@swirls/looms/core'

import { compactJson } from './cn'
import { jsonFields, jsonNumber, jsonText } from './json'

export type SessionEvent = AnyEventEnvelope

export interface EventSummary {
  readonly title: string
  readonly detail?: string
}

interface EventFamily {
  readonly family: string
  readonly prefix: string
  readonly color: string
}

/** Longest prefix wins, so `runtime.wait` beats `runtime`. */
const families: readonly EventFamily[] = [
  { family: 'shuttle', prefix: 'shuttle.', color: 'oklch(0.74 0.13 245)' },
  { family: 'reflect', prefix: 'reflect.', color: 'oklch(0.74 0.12 300)' },
  { family: 'agent', prefix: 'agent.', color: 'oklch(0.78 0.12 200)' },
  { family: 'evaluator', prefix: 'evaluator.', color: 'oklch(0.8 0.12 120)' },
  { family: 'approval', prefix: 'approval.', color: 'oklch(0.8 0.14 70)' },
  { family: 'wait', prefix: 'runtime.wait', color: 'oklch(0.8 0.14 85)' },
  { family: 'effect', prefix: 'runtime.effect', color: 'oklch(0.66 0.02 265)' },
  { family: 'runtime', prefix: 'runtime.', color: 'oklch(0.76 0.13 155)' },
].toSorted((left, right) => right.prefix.length - left.prefix.length)

const fallbackFamily: EventFamily = { family: 'other', prefix: '', color: 'oklch(0.6 0.01 265)' }

function familyFor(type: string): EventFamily {
  return families.find((entry) => type.startsWith(entry.prefix)) ?? fallbackFamily
}

function messageContent(payload: JsonValue): string | undefined {
  return jsonText(jsonFields(jsonFields(payload).message).content) || undefined
}

function definitionLabel(payload: JsonValue): string {
  const fields = jsonFields(payload)
  return `${jsonText(fields.kind) ?? 'thread'}:${jsonText(fields.definitionName) ?? 'unknown'}`
}

function summarizeAgent(event: SessionEvent): EventSummary | undefined {
  const payload = jsonFields(event.payload)

  switch (event.type) {
    case 'agent.message.received':
      return { title: 'message received', detail: messageContent(event.payload) }
    case 'agent.turn.started':
      return { title: 'turn started', detail: `turn ${jsonNumber(payload.turn) ?? ''}` }
    case 'agent.turn.text_delta':
      return { title: 'text delta', detail: jsonText(payload.delta) }

    case 'agent.message': {
      const message = jsonFields(payload.message)
      const calls = Array.isArray(message.toolCalls) ? message.toolCalls.length : 0
      const text = messageContent(event.payload)
      return {
        title: 'agent message',
        detail: text ?? (calls > 0 ? `${calls} tool call${calls === 1 ? '' : 's'}` : undefined),
      }
    }

    case 'agent.tool_call.requested': {
      const call = jsonFields(payload.toolCall)
      return {
        title: `tool ${jsonText(call.name) ?? ''}`,
        detail: compactJson(call.arguments ?? null),
      }
    }

    case 'agent.tool.result': {
      const error = jsonText(payload.error)
      return {
        title: `${error ? 'tool error' : 'tool result'} ${jsonText(payload.name) ?? ''}`,
        detail: error ?? compactJson(payload.result ?? null),
      }
    }

    case 'agent.steered':
      return {
        title: payload.interrupt === true ? 'steered (interrupt)' : 'steered',
        detail: messageContent(event.payload),
      }
    case 'agent.turn.stopped':
      return { title: 'turn stopped' }
    case 'agent.turn.usage':
      return {
        title: 'token usage',
        detail: `in ${jsonNumber(payload.input) ?? 0} · out ${jsonNumber(payload.output) ?? 0}`,
      }

    case 'agent.effects.requested': {
      const effects = Array.isArray(payload.effects) ? payload.effects : []
      return {
        title: 'effects requested',
        detail: effects.map((effect) => jsonText(jsonFields(effect).type) ?? '?').join(', '),
      }
    }

    case 'agent.spawn.requested':
      return { title: 'spawn', detail: definitionLabel(event.payload) }
    default:
      return undefined
  }
}

function summarizeRuntime(event: SessionEvent): EventSummary | undefined {
  const payload = jsonFields(event.payload)

  switch (event.type) {
    case 'runtime.run.started':
      return { title: 'run started', detail: definitionLabel(event.payload) }
    case 'runtime.run.completed':
      return {
        title: jsonText(payload.error) ? 'run failed' : 'run completed',
        detail: jsonText(payload.error) ?? compactJson(payload.output ?? null),
      }
    case 'runtime.run.launched':
      return {
        title: 'run launched',
        detail: `${definitionLabel(event.payload)} · ${jsonText(payload.runId) ?? ''}`,
      }
    case 'runtime.thread.started':
      return { title: 'thread started', detail: definitionLabel(event.payload) }
    case 'runtime.thread.completed':
      return { title: 'thread completed', detail: compactJson(payload.output ?? null) }
    case 'runtime.thread.failed':
      return { title: 'thread failed', detail: jsonText(payload.error) }
    case 'runtime.thread.cancelled':
      return { title: 'thread cancelled', detail: jsonText(payload.reason) }

    case 'runtime.wait.registered': {
      const on = jsonFields(payload.on)
      const type = on.type
      const detail = Array.isArray(type) ? type.map(String).join(', ') : jsonText(type)
      return { title: 'wait registered', detail }
    }

    case 'runtime.wait.satisfied':
      return { title: 'wait satisfied', detail: jsonText(jsonFields(payload.event).type) }
    case 'runtime.effect.failed':
      return { title: 'effect failed', detail: jsonText(payload.error) }
    case 'runtime.signal.received':
      return { title: 'signal', detail: compactJson(event.payload) }
    default:
      return undefined
  }
}

function summarizeShuttle(event: SessionEvent): EventSummary | undefined {
  const payload = jsonFields(event.payload)

  switch (event.type) {
    case 'shuttle.user.said':
      return { title: 'user said', detail: jsonText(payload.text) }
    case 'shuttle.routed':
      return {
        title: `routed → ${jsonText(payload.kind) ?? '?'}`,
        detail: jsonText(payload.summary),
      }
    case 'shuttle.brief.amended':
      return {
        title: `brief v${jsonNumber(payload.version) ?? '?'}`,
        detail: jsonText(payload.text),
      }
    case 'shuttle.playbook.loaded':
      return {
        title: `playbook v${jsonNumber(payload.version) ?? 0} loaded`,
        detail: `${Array.isArray(payload.lessons) ? payload.lessons.length : 0} lessons`,
      }
    case 'shuttle.intake.started':
      return { title: 'intake started', detail: jsonText(payload.messageId) }
    case 'shuttle.conductor.spawned':
      return { title: 'conductor spawned', detail: jsonText(payload.childThreadId) }
    case 'shuttle.narrator.spawned':
      return { title: 'narrator spawned', detail: jsonText(payload.childThreadId) }
    case 'shuttle.reroute':
      return {
        title: `reroute → ${jsonText(payload.kind) ?? '?'}`,
        detail: jsonText(payload.messageId),
      }
    case 'shuttle.reflection.launched':
      return { title: 'reflection launched', detail: jsonText(payload.runId) }
    case 'shuttle.turn.thinking_delta':
      return {
        title: 'thinking delta',
        detail: jsonText(payload.delta),
      }

    case 'shuttle.team.changed':
      return {
        title: 'team changed',
        detail: [
          payload.workers === true ? 'workers' : null,
          payload.codex === true ? 'codex' : null,
          payload.claudeCode === true ? 'claude-code' : null,
        ]
          .filter(Boolean)
          .join(', '),
      }

    case 'shuttle.vendor.turn_started': {
      const model = jsonText(payload.model)

      return {
        title: `${jsonText(payload.label) ?? 'agent'} turn started`,
        detail: model ? `turn ${jsonNumber(payload.turn) ?? ''} · ${model}` : undefined,
      }
    }

    case 'shuttle.vendor.message':
      return { title: 'agent said', detail: jsonText(payload.text) }

    case 'shuttle.vendor.tool_started': {
      const call = jsonFields(payload.toolCall)
      const args = jsonFields(call.arguments)

      return {
        title: `ran ${jsonText(call.name) ?? 'tool'}`,
        detail: jsonText(args.command) ?? jsonText(args.path) ?? jsonText(args.query),
      }
    }

    case 'shuttle.vendor.tool_finished': {
      const error = jsonText(payload.error)

      return {
        title: error ? 'tool failed' : 'tool finished',
        detail: error ?? jsonText(payload.result),
      }
    }

    case 'shuttle.turn.thought': {
      const durationMs = jsonNumber(payload.durationMs)
      return {
        title:
          durationMs !== undefined ? `thought (${(durationMs / 1000).toFixed(1)}s)` : 'thought',
        detail: jsonText(payload.text),
      }
    }

    default:
      return undefined
  }
}

function summarizeApproval(event: SessionEvent): EventSummary | undefined {
  const payload = jsonFields(event.payload)

  switch (event.type) {
    case 'approval.requested':
      return { title: 'approval requested', detail: jsonText(payload.title) }
    case 'approval.decided':
      return {
        title: `approval ${payload.outcome === 'approve' ? 'granted' : 'declined'}`,
        detail: jsonText(jsonFields(payload.payload).answer) ?? jsonText(payload.actionId),
      }
    case 'approval.timed_out':
      return { title: 'approval timed out', detail: jsonText(payload.approvalId) }
    default:
      return undefined
  }
}

export function summarizeEvent(event: SessionEvent): EventSummary {
  return (
    summarizeShuttle(event) ??
    summarizeAgent(event) ??
    summarizeApproval(event) ??
    summarizeRuntime(event) ?? {
      title: event.type.replace(/^[a-z]+\./, ''),
      detail: compactJson(event.payload),
    }
  )
}

export const eventFamilies: readonly string[] = [
  ...new Set([...families.map((entry) => entry.family), fallbackFamily.family]),
]

export function familyOf(type: string): string {
  return familyFor(type).family
}

export function familyColor(family: string): string {
  return families.find((entry) => entry.family === family)?.color ?? fallbackFamily.color
}

interface CachedMeta {
  readonly summary: EventSummary
  readonly family: string
  readonly searchText: string
}

const metaCache = new WeakMap<object, CachedMeta>()

export function eventMeta(event: SessionEvent): CachedMeta {
  const cached = metaCache.get(event)

  if (cached) {
    return cached
  }

  const summary = summarizeEvent(event)

  const meta: CachedMeta = {
    summary,
    family: familyOf(event.type),
    searchText: [event.type, event.threadId ?? '', summary.title, summary.detail ?? '']
      .join(' ')
      .toLowerCase(),
  }

  metaCache.set(event, meta)
  return meta
}

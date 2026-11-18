import { Schema } from 'effect'
import { z } from 'zod'

import { defineTool } from '@swirls/looms/agent'
import {
  cleanUndefined,
  isJsonObject,
  isJsonString,
  type JsonObject,
  type JsonValue,
} from '@swirls/looms/core'

import type { ShuttleEnv } from '../env'
import { loomsStub } from '../looms-stub'
import { present } from '../present'
import {
  workAgentsForRead,
  workInitialState,
  workShape,
  type WorkProjectionState,
} from '../session/work-projection'

function asJson(value: HistoryQueryResult): JsonValue {
  return cleanUndefined({
    available: value.available,
    rows: value.rows,
    note: present(value.note),
    readAt: value.readAt,
    lastEventAt: value.lastEventAt,
    idleMs: value.idleMs,
  })
}

export interface HistoryQueryResult {
  readonly available: boolean
  readonly rows: readonly JsonObject[]
  readonly note?: string
  readonly readAt?: number
  /** When the run last recorded any event. */
  readonly lastEventAt?: number
  /** How long before `readAt` that was. */
  readonly idleMs?: number
}

const RowsSchema = z.array(z.record(z.string(), z.json()))

/** The text in a column, or nothing when it holds anything else. */
function textOf(value: JsonValue | undefined): string {
  return isJsonString(value) ? value : ''
}

async function queryReplica(
  env: ShuttleEnv,
  sql: string,
  params: readonly (string | number)[] = [],
): Promise<HistoryQueryResult | null> {
  if (!env.REPLICA) {
    return null
  }

  const statement = env.REPLICA.prepare(sql)
  const bound = params.length > 0 ? statement.bind(...params) : statement
  const result = await bound.all()

  return {
    available: true,
    rows: RowsSchema.parse(result.results),
  }
}

const StoredEventSchema = z.object({
  runId: z.string(),
  seq: z.number(),
  type: z.string(),
  ts: z.number(),
  payload: z.json().optional(),
  threadId: z.string().nullable().optional(),
})

type StoredEvent = z.infer<typeof StoredEventSchema>

const EventsBodySchema = z.object({ events: z.array(StoredEventSchema).optional() })

const WorkBodySchema = Schema.Struct({ value: Schema.optional(workShape) })

const FrictionBodySchema = z.object({
  value: z.object({ entries: z.array(z.record(z.string(), z.json())).optional() }).optional(),
})

const PayloadSchema = z.record(z.string(), z.json())

/** Events read per request while walking a run's log backwards. */
const EVENT_PAGE = 500

/** How far back a read walks before giving up, so a question on a huge log stays quick. */
const MAX_EVENTS_SCANNED = 20_000

/**
 * The newest `limit` events that `keep` accepts, newest first, read backwards from `tail` a
 * page at a time. A session's log is mostly streaming deltas, so the newest few hundred events
 * can hold nothing else; reading from the start instead would show only the session's opening
 * minutes.
 */
export async function readRecentEvents(input: {
  readonly tail: number
  readonly limit: number
  readonly keep: (event: StoredEvent) => boolean
  readonly readPage: (fromSeq: number, limit: number) => Promise<readonly StoredEvent[] | null>
}): Promise<{ events: StoredEvent[]; complete: boolean } | null> {
  const kept: StoredEvent[] = []
  let below = input.tail + 1

  while (below > 1 && kept.length < input.limit && input.tail - below < MAX_EVENTS_SCANNED) {
    const fromSeq = Math.max(1, below - EVENT_PAGE)
    const page = await input.readPage(fromSeq, below - fromSeq)

    if (page === null) {
      return kept.length > 0 ? { events: kept, complete: false } : null
    }

    kept.push(...page.filter(input.keep).toSorted((left, right) => right.seq - left.seq))
    below = fromSeq
  }

  return { events: kept.slice(0, input.limit), complete: below <= 1 }
}

async function eventsFromDurableObject(
  env: ShuttleEnv,
  runId: string,
  limit: number,
  keep: (event: { readonly type: string }) => boolean = () => true,
): Promise<HistoryQueryResult> {
  const stub = loomsStub(env.LOOMS_RUN, runId)
  let status = 0

  const read = await readRecentEvents({
    tail: await stub.getStreamTail(),
    limit,
    keep,
    readPage: async (fromSeq, count) => {
      const response = await stub.fetch(
        new Request(
          `https://shuttle.internal/runs/${encodeURIComponent(runId)}/events?fromSeq=${fromSeq}&limit=${count}`,
        ),
      )

      if (!response.ok) {
        status = response.status
        return null
      }

      const body = EventsBodySchema.parse(await response.json())
      return body.events ?? []
    },
  })

  if (!read) {
    return {
      available: false,
      rows: [],
      note: `Could not read events from Durable Object (${status}).`,
    }
  }

  const rows: JsonObject[] = read.events.map((event) => ({
    run_id: event.runId,
    seq: event.seq,
    type: event.type,
    ts: event.ts,
    payload_json: JSON.stringify(event.payload ?? null),
    thread_id: event.threadId ?? null,
  }))

  const notes: string[] = []

  if (env.REPLICA === undefined) {
    notes.push('Served from the run Durable Object (D1 REPLICA not bound).')
  }

  if (!read.complete) {
    notes.push('Older events were not searched.')
  }

  return {
    available: true,
    rows,
    note: notes.length > 0 ? notes.join(' ') : undefined,
  }
}

/** When the run last recorded anything, deltas included. Null when it cannot be read. */
async function lastEventAt(env: ShuttleEnv, runId: string): Promise<number | null> {
  const stub = loomsStub(env.LOOMS_RUN, runId)
  const tail = await stub.getStreamTail()

  if (tail < 1) {
    return null
  }

  const response = await stub.fetch(
    new Request(
      `https://shuttle.internal/runs/${encodeURIComponent(runId)}/events?fromSeq=${tail}&limit=1`,
    ),
  )

  if (!response.ok) {
    return null
  }

  const body = EventsBodySchema.parse(await response.json())
  return body.events?.[0]?.ts ?? null
}

/** The JSON payload an event row carries; an empty one when it is missing or damaged. */
function parsePayload(column: JsonValue | undefined): JsonObject {
  try {
    return PayloadSchema.catch({}).parse(JSON.parse(isJsonString(column) ? column : '{}'))
  } catch {
    return {}
  }
}

function isDeltaEventType(type: string): boolean {
  return type.endsWith('_delta')
}

async function workFromDurableObject(
  env: ShuttleEnv,
  runId: string,
): Promise<{ available: boolean; state: WorkProjectionState; note?: string }> {
  const stub = loomsStub(env.LOOMS_RUN, runId)

  const response = await stub.fetch(
    new Request(`https://shuttle.internal/runs/${encodeURIComponent(runId)}/projections/work`),
  )

  if (!response.ok) {
    return {
      available: false,
      state: workInitialState,
      note: `Could not read work projection (${response.status}).`,
    }
  }

  const body = Schema.decodeUnknownSync(WorkBodySchema)(await response.json())

  return {
    available: true,
    state: body.value ?? workInitialState,
    note: env.REPLICA ? undefined : 'Served from the work projection (D1 REPLICA not bound).',
  }
}

const FRICTION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'agent.steered',
  'agent.turn.stopped',
  'agent.tool.result',
  'reflect.friction.recorded',
])

async function frictionFromDurableObject(
  env: ShuttleEnv,
  runId: string,
  limit: number,
): Promise<HistoryQueryResult> {
  const stub = loomsStub(env.LOOMS_RUN, runId)

  const response = await stub.fetch(
    new Request(`https://shuttle.internal/runs/${encodeURIComponent(runId)}/projections/friction`),
  )

  if (response.ok) {
    const body = FrictionBodySchema.parse(await response.json())

    const entries = body.value?.entries ?? []

    return {
      available: true,
      rows: entries.slice(-limit).toReversed(),
      note: env.REPLICA ? undefined : 'Served from the friction projection (D1 REPLICA not bound).',
    }
  }

  // Projection miss: derive friction the same way the reflect reducer does.
  const events = await eventsFromDurableObject(env, runId, Math.max(limit * 4, 80), (event) =>
    FRICTION_EVENT_TYPES.has(event.type),
  )

  if (!events.available) {
    return events
  }

  const rows = events.rows.flatMap((row) => {
    const type = textOf(row.type)
    const payload = parsePayload(row.payload_json)

    if (type === 'agent.steered' && payload.interrupt === true) {
      const { message } = payload
      const content = isJsonObject(message) ? message.content : undefined

      return [
        {
          kind: 'correction',
          summary: isJsonString(content) ? content : 'interrupted steer',
          runId: row.run_id ?? null,
          seq: row.seq ?? null,
          threadId: row.thread_id ?? null,
        },
      ]
    }

    if (type === 'agent.turn.stopped') {
      return [
        {
          kind: 'stop',
          summary: 'User stopped an in-flight turn',
          runId: row.run_id ?? null,
          seq: row.seq ?? null,
          threadId: row.thread_id ?? null,
        },
      ]
    }

    const { error, name } = payload

    if (type === 'agent.tool.result' && isJsonString(error) && error !== '') {
      return [
        {
          kind: 'tool_error',
          summary: `${isJsonString(name) ? name : 'tool'}: ${error}`,
          runId: row.run_id ?? null,
          seq: row.seq ?? null,
          threadId: row.thread_id ?? null,
        },
      ]
    }

    if (type === 'reflect.friction.recorded') {
      return [payload]
    }

    return []
  })

  return {
    available: true,
    rows: rows.slice(0, limit),
    note: 'Derived from Durable Object events (D1 REPLICA not bound).',
  }
}

export function createHistoryTools(env: ShuttleEnv, runId: string) {
  const queryEvents = defineTool({
    name: 'query_events',
    description:
      'Query recent durable events for this session. Streaming delta events (types ending in _delta, including shuttle.turn.thinking_delta) are excluded by default; set includeDeltas to include them.',
    input: z.object({
      runId: z.string().optional(),
      typePrefix: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      includeDeltas: z.boolean().optional(),
    }),
    handler: async (input) => {
      const targetRunId = input.runId ?? runId
      const limit = input.limit ?? 40
      const includeDeltas = input.includeDeltas ?? false
      const overshoot = includeDeltas ? limit : limit * 3

      const typePrefix = present(input.typePrefix)

      if (typePrefix !== undefined) {
        const fromReplica = await queryReplica(
          env,
          `SELECT run_id, seq, type, ts, payload_json
           FROM looms_run_events
           WHERE run_id = ? AND type LIKE ?
           ORDER BY seq DESC
           LIMIT ?`,
          [targetRunId, `${typePrefix}%`, overshoot],
        )

        if (fromReplica) {
          const rows = includeDeltas
            ? fromReplica.rows
            : fromReplica.rows.filter((row) => !isDeltaEventType(textOf(row.type)))

          return asJson({
            ...fromReplica,
            rows: rows.slice(0, limit),
          })
        }
      } else {
        const fromReplica = await queryReplica(
          env,
          `SELECT run_id, seq, type, ts, payload_json
           FROM looms_run_events
           WHERE run_id = ?
           ORDER BY seq DESC
           LIMIT ?`,
          [targetRunId, overshoot],
        )

        if (fromReplica) {
          const rows = includeDeltas
            ? fromReplica.rows
            : fromReplica.rows.filter((row) => !isDeltaEventType(textOf(row.type)))

          return asJson({
            ...fromReplica,
            rows: rows.slice(0, limit),
          })
        }
      }

      return asJson(
        await eventsFromDurableObject(
          env,
          targetRunId,
          limit,
          (event) =>
            (includeDeltas || !isDeltaEventType(event.type)) &&
            (typePrefix === undefined || event.type.startsWith(typePrefix)),
        ),
      )
    },
  })

  const runTree = defineTool({
    name: 'run_tree',
    description: 'List runs that share this session correlation id',
    input: z.object({
      correlationId: z.string().optional(),
    }),
    handler: async (input) => {
      const correlationId = input.correlationId ?? runId

      const fromReplica = await queryReplica(
        env,
        `SELECT run_id, kind, definition_name, status, parent_run_id, correlation_id, updated_at
         FROM looms_run_index
         WHERE correlation_id = ? OR run_id = ?
         ORDER BY updated_at DESC
         LIMIT 50`,
        [correlationId, correlationId],
      )

      if (fromReplica) {
        return asJson(fromReplica)
      }

      return asJson({
        available: true,
        rows: [{ run_id: correlationId, note: 'index unavailable without D1' }],
        note: 'Run index requires D1 REPLICA; returning the requested id only.',
      })
    },
  })

  const friction = defineTool({
    name: 'friction',
    description: 'Read friction entries projected from agent corrections and tool failures',
    input: z.object({
      runId: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    handler: async (input) => {
      const targetRunId = input.runId ?? runId
      const limit = input.limit ?? 40

      const fromReplica = await queryReplica(
        env,
        `SELECT run_id, seq, type, ts, payload_json
         FROM looms_run_events
         WHERE run_id = ?
           AND (
             type = 'agent.steered'
             OR type = 'agent.turn.stopped'
             OR type = 'agent.tool.result'
             OR type = 'reflect.friction.recorded'
           )
         ORDER BY seq DESC
         LIMIT ?`,
        [targetRunId, limit],
      )

      if (fromReplica) {
        return asJson(fromReplica)
      }

      return asJson(await frictionFromDurableObject(env, targetRunId, limit))
    },
  })

  /**
   * A working session records something every few seconds: model output streams as deltas and
   * tools report as they finish. Two quiet minutes while agents are working is worth saying.
   */
  const SESSION_IDLE_MS = 120_000
  const WORKING_STATUSES: ReadonlySet<string> = new Set(['thinking', 'tool', 'waiting_on_children'])

  const sessionStatus = defineTool({
    name: 'session_status',
    description:
      'Read the live work projection for this session: each agent thread, task, status, recent tools, files touched, and stuck signals (with tool elapsed time computed at read time). idleMs is how long ago the session recorded anything at all.',
    input: z.object({
      runId: z.string().optional(),
    }),
    handler: async (input) => {
      const targetRunId = input.runId ?? runId
      const now = Date.now()
      const work = await workFromDurableObject(env, targetRunId)

      if (!work.available) {
        return asJson({
          available: false,
          rows: [],
          note: work.note,
        })
      }

      const agents = workAgentsForRead(work.state, now)
      const lastAt = await lastEventAt(env, targetRunId).catch(() => null)
      const idleMs = lastAt === null ? null : Math.max(0, now - lastAt)
      const busy = agents.some((agent) => WORKING_STATUSES.has(agent.status.kind))

      const stalled =
        idleMs !== null && busy && idleMs >= SESSION_IDLE_MS
          ? `Agents are marked as working but the session has recorded nothing for ${Math.round(idleMs / 1000)} seconds. It may be stalled.`
          : undefined

      const notes = [work.note, stalled].filter((note) => note !== undefined)

      return cleanUndefined({
        available: true,
        rows: agents,
        readAt: now,
        lastEventAt: lastAt ?? undefined,
        idleMs: idleMs ?? undefined,
        note: notes.length > 0 ? notes.join(' ') : undefined,
      })
    },
  })

  return { queryEvents, runTree, friction, sessionStatus }
}

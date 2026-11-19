import { Schema } from 'effect'
import { z } from 'zod'

import { EventEnvelopeSchema, fromWireEvent, type EventEnvelope } from '@swirls/looms/core'

import { RUN_KINDS, type RunKind } from './run-kind'

/** Max retained rows in the ring buffer. */
export const MAX_EVENTS = 50_000

/** Drop events older than this many milliseconds. */
export const MAX_AGE_MS = 24 * 60 * 60 * 1000

const SCHEMA = `
CREATE TABLE IF NOT EXISTS firehose_events (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  run_kind TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  thread_id TEXT,
  envelope TEXT NOT NULL,
  UNIQUE (run_id, seq)
);

CREATE INDEX IF NOT EXISTS firehose_events_ts ON firehose_events (ts);
CREATE INDEX IF NOT EXISTS firehose_events_run ON firehose_events (run_id, cursor);
CREATE INDEX IF NOT EXISTS firehose_events_kind ON firehose_events (run_kind, cursor);
`

export type FirehoseSqlRow = Record<string, SqlStorageValue>

/** The part of a Durable Object SQL cursor the firehose reads: its rows and its write count. */
export interface FirehoseCursor extends Iterable<FirehoseSqlRow> {
  readonly rowsWritten: number
}

/** Subset of Durable Object SqlStorage used by the firehose. */
export interface FirehoseSql {
  exec(query: string, ...bindings: SqlStorageValue[]): FirehoseCursor
}

export interface FirehoseRow {
  readonly cursor: number
  readonly runId: string
  readonly runKind: RunKind
  readonly seq: number
  readonly ts: number
  readonly type: string
  readonly threadId: string | null
  readonly event: EventEnvelope
}

export interface FirehoseFilter {
  readonly runKinds?: readonly RunKind[]
  readonly runIds?: readonly string[]
  readonly families?: readonly string[]
}

export interface FirehoseFrame {
  readonly cursor: number
  readonly runId: string
  readonly runKind: RunKind
  readonly event: EventEnvelope
}

export function ensureFirehoseSchema(sql: FirehoseSql): void {
  sql.exec(SCHEMA)
}

const FirehoseRowSchema = z.object({
  cursor: z.number(),
  run_id: z.string(),
  run_kind: z.enum(RUN_KINDS),
  seq: z.number(),
  ts: z.number(),
  type: z.string(),
  thread_id: z.string().nullable(),
  envelope: z.string(),
})

const MaxCursorRowSchema = z.object({ max_cursor: z.number() })
const CountRowSchema = z.object({ n: z.number() })

const decodeEnvelope = Schema.decodeUnknownSync(EventEnvelopeSchema)

/**
 * A stored row as a frame's source, or undefined when it can no longer be read (written by a
 * version whose envelope differs). One such row is left out so it does not hide the rest.
 */
function parseRow(raw: FirehoseSqlRow): FirehoseRow | undefined {
  const row = FirehoseRowSchema.safeParse(raw)

  if (!row.success) {
    return undefined
  }

  try {
    return {
      cursor: row.data.cursor,
      runId: row.data.run_id,
      runKind: row.data.run_kind,
      seq: row.data.seq,
      ts: row.data.ts,
      type: row.data.type,
      threadId: row.data.thread_id,
      event: fromWireEvent(decodeEnvelope(JSON.parse(row.data.envelope))),
    }
  } catch {
    return undefined
  }
}

function parseRows(raws: readonly FirehoseSqlRow[]): FirehoseRow[] {
  return raws.flatMap((raw) => {
    const row = parseRow(raw)

    return row === undefined ? [] : [row]
  })
}

function rowToFrame(row: FirehoseRow): FirehoseFrame {
  return {
    cursor: row.cursor,
    runId: row.runId,
    runKind: row.runKind,
    event: row.event,
  }
}

export function familyOfType(type: string): string {
  if (type.startsWith('shuttle.')) {
    return 'shuttle'
  }

  if (type.startsWith('reflect.')) {
    return 'reflect'
  }

  if (type.startsWith('agent.')) {
    return 'agent'
  }

  if (type.startsWith('evaluator.')) {
    return 'evaluator'
  }

  if (type.startsWith('approval.')) {
    return 'approval'
  }

  if (type.startsWith('runtime.wait')) {
    return 'wait'
  }

  if (type.startsWith('runtime.effect')) {
    return 'effect'
  }

  if (type.startsWith('runtime.')) {
    return 'runtime'
  }

  return 'other'
}

export function matchesFirehoseFilter(
  row: Pick<FirehoseRow, 'runId' | 'runKind' | 'type'>,
  filter: FirehoseFilter,
): boolean {
  if (filter.runKinds && filter.runKinds.length > 0 && !filter.runKinds.includes(row.runKind)) {
    return false
  }

  if (filter.runIds && filter.runIds.length > 0 && !filter.runIds.includes(row.runId)) {
    return false
  }

  if (
    filter.families &&
    filter.families.length > 0 &&
    !filter.families.includes(familyOfType(row.type))
  ) {
    return false
  }

  return true
}

/**
 * Insert committed envelopes. Idempotent on `(run_id, seq)`.
 * Skips envelopes already outside the retention window so projector catch-up
 * cannot flood the ring buffer with ancient history.
 * Returns only frames newly allocated by this call.
 */
export function ingest(
  sql: FirehoseSql,
  runId: string,
  runKind: RunKind,
  events: ReadonlyArray<EventEnvelope>,
  now = Date.now(),
): FirehoseFrame[] {
  if (events.length === 0) {
    return []
  }

  const [before] = [
    ...sql.exec('SELECT COALESCE(MAX(cursor), 0) AS max_cursor FROM firehose_events'),
  ]

  const maxBefore = MaxCursorRowSchema.safeParse(before).data?.max_cursor ?? 0
  const minTs = now - MAX_AGE_MS
  const fresh: FirehoseFrame[] = []

  for (const event of events) {
    if (event.ephemeral === true) {
      continue
    }

    const ts = Number.isFinite(event.ts) ? event.ts : now

    if (ts < minTs) {
      continue
    }

    const threadId = event.threadId ?? null
    const envelope = JSON.stringify(event)

    sql.exec(
      `INSERT OR IGNORE INTO firehose_events (run_id, run_kind, seq, ts, type, thread_id, envelope)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      runId,
      runKind,
      event.seq,
      ts,
      event.type,
      threadId,
      envelope,
    )

    const [row] = [
      ...sql.exec(
        `SELECT cursor, run_id, run_kind, seq, ts, type, thread_id, envelope
         FROM firehose_events
         WHERE run_id = ? AND seq = ? AND cursor > ?`,
        runId,
        event.seq,
        maxBefore,
      ),
    ]

    if (!row) {
      continue
    }

    const parsed = parseRow(row)

    if (parsed !== undefined) {
      fresh.push(rowToFrame(parsed))
    }
  }

  return fresh
}

interface FilterClause {
  readonly clause: string
  readonly bindings: SqlStorageValue[]
}

function buildFilterClause(filter: FirehoseFilter): FilterClause {
  const parts: string[] = []
  const bindings: SqlStorageValue[] = []

  if (filter.runKinds && filter.runKinds.length > 0) {
    parts.push(`run_kind IN (${filter.runKinds.map(() => '?').join(', ')})`)
    bindings.push(...filter.runKinds)
  }

  if (filter.runIds && filter.runIds.length > 0) {
    parts.push(`run_id IN (${filter.runIds.map(() => '?').join(', ')})`)
    bindings.push(...filter.runIds)
  }

  return {
    clause: parts.length > 0 ? ` AND ${parts.join(' AND ')}` : '',
    bindings,
  }
}

function applyFamilyFilter(rows: FirehoseRow[], filter: FirehoseFilter): FirehoseRow[] {
  const { families } = filter

  if (families === undefined || families.length === 0) {
    return rows
  }

  return rows.filter((row) => families.includes(familyOfType(row.type)))
}

/** Read forward from a cursor (exclusive). */
export function readAfter(
  sql: FirehoseSql,
  cursor: number,
  limit: number,
  filter: FirehoseFilter = {},
): FirehoseFrame[] {
  const safeLimit = Math.max(1, Math.min(limit, 1000))
  const { clause, bindings } = buildFilterClause(filter)

  // Over-fetch when family filter is present so in-memory filtering still fills the page.
  const fetchLimit = filter.families && filter.families.length > 0 ? safeLimit * 4 : safeLimit

  const rows = parseRows([
    ...sql.exec(
      `SELECT cursor, run_id, run_kind, seq, ts, type, thread_id, envelope
       FROM firehose_events
       WHERE cursor > ?${clause}
       ORDER BY cursor ASC
       LIMIT ?`,
      cursor,
      ...bindings,
      fetchLimit,
    ),
  ])

  return applyFamilyFilter(rows, filter).slice(0, safeLimit).map(rowToFrame)
}

/** Read backward from a cursor (exclusive) for scrollback. Results are ascending. */
export function readBefore(
  sql: FirehoseSql,
  cursor: number,
  limit: number,
  filter: FirehoseFilter = {},
): FirehoseFrame[] {
  const safeLimit = Math.max(1, Math.min(limit, 1000))
  const { clause, bindings } = buildFilterClause(filter)
  const fetchLimit = filter.families && filter.families.length > 0 ? safeLimit * 4 : safeLimit

  const rows = parseRows([
    ...sql.exec(
      `SELECT cursor, run_id, run_kind, seq, ts, type, thread_id, envelope
       FROM firehose_events
       WHERE cursor < ?${clause}
       ORDER BY cursor DESC
       LIMIT ?`,
      cursor,
      ...bindings,
      fetchLimit,
    ),
  ])

  return applyFamilyFilter(rows, filter).slice(0, safeLimit).toReversed().map(rowToFrame)
}

/** Drop rows past age or count caps. Returns number of deleted rows. */
export function pruneFirehose(
  sql: FirehoseSql,
  now = Date.now(),
  maxEvents = MAX_EVENTS,
  maxAgeMs = MAX_AGE_MS,
): number {
  const minTs = now - maxAgeMs
  let deleted = 0

  const ageResult = sql.exec(`DELETE FROM firehose_events WHERE ts < ?`, minTs)
  deleted += ageResult.rowsWritten

  const [countRow] = [...sql.exec(`SELECT COUNT(*) AS n FROM firehose_events`)]
  const count = CountRowSchema.safeParse(countRow).data?.n ?? 0

  if (count <= maxEvents) {
    return deleted
  }

  const excess = count - maxEvents

  const excessResult = sql.exec(
    `DELETE FROM firehose_events
     WHERE cursor IN (
       SELECT cursor FROM firehose_events ORDER BY cursor ASC LIMIT ?
     )`,
    excess,
  )

  deleted += excessResult.rowsWritten
  return deleted
}

export function latestCursor(sql: FirehoseSql): number {
  const [row] = [...sql.exec(`SELECT COALESCE(MAX(cursor), 0) AS max_cursor FROM firehose_events`)]
  return MaxCursorRowSchema.safeParse(row).data?.max_cursor ?? 0
}

export function eventCount(sql: FirehoseSql): number {
  const [row] = [...sql.exec(`SELECT COUNT(*) AS n FROM firehose_events`)]
  return CountRowSchema.safeParse(row).data?.n ?? 0
}

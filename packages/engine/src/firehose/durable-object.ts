import { DurableObject } from 'cloudflare:workers'
import { z } from 'zod'

import type { EventEnvelope } from '@swirls/looms/core'

import type { EngineEnv } from '../env'
import { RunKindSchema, runKindFor, type RunKind } from './run-kind'
import {
  ensureFirehoseSchema,
  ingest,
  latestCursor,
  matchesFirehoseFilter,
  pruneFirehose,
  readAfter,
  readBefore,
  type FirehoseFilter,
  type FirehoseFrame,
} from './store'

const TextSchema = z.string()

/** The values of `items` that are text. */
function textsOf(items: readonly unknown[]): string[] {
  return items.flatMap((item) => {
    const text = TextSchema.safeParse(item)

    return text.success ? [text.data] : []
  })
}

/** A run kind field of a filter message: text to split, or a list of values of which text counts. */
const RunKindsFieldSchema = z
  .union([
    z.string().transform((text) => parseRunKinds(text)),
    z.array(z.unknown()).transform((items) => parseRunKinds(textsOf(items).join(','))),
  ])
  .optional()
  .catch(undefined)

/** A name list field of a filter message, read the same two ways. */
const NamesFieldSchema = z
  .union([
    z.string().transform((text) => parseList(text)),
    z.array(z.unknown()).transform((items) => textsOf(items)),
  ])
  .optional()
  .catch(undefined)

/** A client asking for a different filter, or a different place to read from. */
const FilterMessageSchema = z.object({
  type: z.literal('filter'),
  runKind: RunKindsFieldSchema,
  runId: NamesFieldSchema,
  family: NamesFieldSchema,
  after: z.number().optional().catch(undefined),
})

const BACKLOG_LIMIT = 200
const PAGE_LIMIT = 200
const PRUNE_ALARM_MS = 60_000

interface SocketAttachment {
  readonly filter: FirehoseFilter
  readonly after: number
}

const SocketAttachmentSchema = z.object({
  filter: z.object({
    runKinds: z.array(RunKindSchema).optional(),
    runIds: z.array(z.string()).optional(),
    families: z.array(z.string()).optional(),
  }),
  after: z.number(),
})

function parseList(value: string | null): string[] {
  if (value === null || value === '') {
    return []
  }

  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

function parseRunKinds(value: string | null): RunKind[] {
  return parseList(value).flatMap((part) => {
    const kind = RunKindSchema.safeParse(part)

    return kind.success ? [kind.data] : []
  })
}

function nonEmpty<T>(items: readonly T[] | undefined): readonly T[] | undefined {
  return items !== undefined && items.length > 0 ? items : undefined
}

function filterOf(
  runKinds: readonly RunKind[] | undefined,
  runIds: readonly string[] | undefined,
  families: readonly string[] | undefined,
): FirehoseFilter {
  return { runKinds: nonEmpty(runKinds), runIds: nonEmpty(runIds), families: nonEmpty(families) }
}

function filterFromSearch(url: URL): FirehoseFilter {
  return filterOf(
    parseRunKinds(url.searchParams.get('runKind')),
    parseList(url.searchParams.get('runId')),
    parseList(url.searchParams.get('family')),
  )
}

function parseAfter(url: URL): number {
  const raw = url.searchParams.get('after')

  if (raw === null || raw === '') {
    return 0
  }

  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : 0
}

function parseCursorParam(value: string | null): number | null {
  if (value === null || value === '') {
    return null
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function parseLimit(url: URL, fallback: number): number {
  const raw = url.searchParams.get('limit')

  if (raw === null) {
    return fallback
  }

  const value = Number(raw)
  return Number.isFinite(value) ? Math.max(1, Math.min(value, 1000)) : fallback
}

function readAttachment(ws: WebSocket): SocketAttachment | null {
  if (!('deserializeAttachment' in ws)) {
    return null
  }

  return SocketAttachmentSchema.safeParse(ws.deserializeAttachment()).data ?? null
}

function writeAttachment(ws: WebSocket, attachment: SocketAttachment): void {
  if (!('serializeAttachment' in ws)) {
    return
  }

  ws.serializeAttachment(attachment)
}

function sendFrame(ws: WebSocket, frame: FirehoseFrame): void {
  ws.send(JSON.stringify(frame))
}

/** What the firehose says to a socket besides event frames. */
type FirehoseControl =
  | { readonly type: 'error'; readonly error: string }
  | { readonly type: 'filter.applied'; readonly after: number }
  | { readonly type: 'ready'; readonly after: number }

function sendJson(ws: WebSocket, payload: FirehoseControl): void {
  ws.send(JSON.stringify(payload))
}

/**
 * Singleton Durable Object that retains a bounded global event log and fans
 * live frames out to hibernating WebSocket subscribers.
 */
export class EventFirehose extends DurableObject<EngineEnv> {
  private schemaReady = false

  private ensureSchema(): void {
    if (this.schemaReady) {
      return
    }

    ensureFirehoseSchema(this.ctx.storage.sql)
    this.schemaReady = true
  }

  async ingest(runId: string, events: ReadonlyArray<EventEnvelope>): Promise<{ inserted: number }> {
    this.ensureSchema()

    if (events.length === 0) {
      return { inserted: 0 }
    }

    const runKind = runKindFor(this.env, runId)
    const frames = ingest(this.ctx.storage.sql, runId, runKind, events)

    if (frames.length > 0) {
      this.broadcast(frames)
      await this.schedulePrune()
    }

    return { inserted: frames.length }
  }

  override async fetch(request: Request): Promise<Response> {
    this.ensureSchema()

    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/firehose/events') {
      return this.handleEventsPage(url)
    }

    if (request.method === 'GET' && url.pathname === '/firehose/socket') {
      return this.handleSocketUpgrade(request, url)
    }

    if (request.method === 'GET' && url.pathname === '/firehose/tail') {
      return Response.json({ cursor: latestCursor(this.ctx.storage.sql) })
    }

    return new Response('Not Found', { status: 404 })
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.ensureSchema()

    if (message instanceof ArrayBuffer) {
      return
    }

    let record: z.infer<typeof FilterMessageSchema> | undefined

    try {
      record = FilterMessageSchema.safeParse(JSON.parse(message)).data
    } catch {
      sendJson(ws, { type: 'error', error: 'invalid json' })
      return
    }

    if (record === undefined) {
      return
    }

    const current = readAttachment(ws) ?? { filter: {}, after: 0 }

    const filter = filterOf(
      record.runKind ?? current.filter.runKinds,
      record.runId ?? current.filter.runIds,
      record.family ?? current.filter.families,
    )

    const after = record.after ?? current.after

    writeAttachment(ws, { filter, after })

    const backlog = readAfter(this.ctx.storage.sql, after, BACKLOG_LIMIT, filter)

    for (const frame of backlog) {
      sendFrame(ws, frame)
    }

    const nextAfter = backlog.at(-1)?.cursor ?? after
    writeAttachment(ws, { filter, after: nextAfter })
    sendJson(ws, { type: 'filter.applied', after: nextAfter })
  }

  override async alarm(): Promise<void> {
    this.ensureSchema()
    pruneFirehose(this.ctx.storage.sql)
  }

  private handleEventsPage(url: URL): Response {
    const filter = filterFromSearch(url)
    const limit = parseLimit(url, PAGE_LIMIT)
    const after = parseCursorParam(url.searchParams.get('after'))
    const before = parseCursorParam(url.searchParams.get('before'))

    if (after !== null && before !== null) {
      return Response.json({ error: 'pass after or before, not both' }, { status: 400 })
    }

    const frames =
      before !== null
        ? readBefore(this.ctx.storage.sql, before, limit, filter)
        : readAfter(this.ctx.storage.sql, after ?? 0, limit, filter)

    return Response.json({
      cursor: latestCursor(this.ctx.storage.sql),
      events: frames,
    })
  }

  private handleSocketUpgrade(request: Request, url: URL): Response {
    const upgrade = request.headers.get('Upgrade')

    if (upgrade === null || upgrade.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 })
    }

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    const filter = filterFromSearch(url)
    const after = parseAfter(url)

    this.ctx.acceptWebSocket(server)
    writeAttachment(server, { filter, after })

    const backlog = readAfter(this.ctx.storage.sql, after, BACKLOG_LIMIT, filter)

    for (const frame of backlog) {
      sendFrame(server, frame)
    }

    const nextAfter = backlog.at(-1)?.cursor ?? after
    writeAttachment(server, { filter, after: nextAfter })
    sendJson(server, { type: 'ready', after: nextAfter })

    return new Response(null, { status: 101, webSocket: client })
  }

  private broadcast(frames: readonly FirehoseFrame[]): void {
    const sockets = this.ctx.getWebSockets()

    for (const ws of sockets) {
      const attachment = readAttachment(ws)

      if (!attachment) {
        continue
      }

      let last = attachment.after

      for (const frame of frames) {
        if (frame.cursor <= attachment.after) {
          continue
        }

        if (
          !matchesFirehoseFilter(
            { runId: frame.runId, runKind: frame.runKind, type: frame.event.type },
            attachment.filter,
          )
        ) {
          continue
        }

        try {
          sendFrame(ws, frame)
          last = frame.cursor
        } catch {
          // Dropped sockets are cleaned up by the platform.
        }
      }

      if (last !== attachment.after) {
        writeAttachment(ws, { filter: attachment.filter, after: last })
      }
    }
  }

  private async schedulePrune(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm()

    if (existing !== null) {
      return
    }

    await this.ctx.storage.setAlarm(Date.now() + PRUNE_ALARM_MS)
  }
}

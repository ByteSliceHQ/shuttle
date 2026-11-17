import { Link } from '@tanstack/react-router'

import { cn, shortId } from '@/lib/cn'

import { eventMeta, familyColor, type SessionEvent } from './event-catalog'

/** Which optional columns a row shows. Leave it out for the default set. */
export interface EventRowColumns {
  readonly seq: boolean
  readonly time: boolean
  readonly session: boolean
  readonly detail: boolean
}

export function EventRow({
  event,
  startedAt,
  threadLabel,
  runLabel,
  runId,
  timeMode = 'offset',
  columns,
  selected,
  onSelectSeq,
}: {
  event: SessionEvent
  startedAt?: number
  threadLabel?: string
  /** Optional session / run chip shown on the global log. */
  runLabel?: string
  runId?: string
  timeMode?: 'offset' | 'absolute'
  /** Explicit column choices. Without them the time column follows the container's width. */
  columns?: EventRowColumns
  selected: boolean
  onSelectSeq: (seq: number | undefined) => void
}) {
  const meta = eventMeta(event)
  const offset = startedAt !== undefined ? Math.max(0, event.ts - startedAt) : undefined

  return (
    <button
      type="button"
      onClick={() => onSelectSeq(selected ? undefined : event.seq)}
      title={[meta.summary.title, meta.summary.detail].filter(Boolean).join(' — ')}
      className={cn(
        'flex h-[26px] w-full items-center gap-2 rounded-sm px-1.5 text-left font-mono text-[11px] transition-colors duration-100',
        selected ? 'bg-accent' : 'hover:bg-accent/40',
        event.ephemeral && 'opacity-50',
      )}
    >
      <span
        className="size-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: familyColor(meta.family) }}
      />
      {(columns?.seq ?? true) ? (
        <span className="text-muted-foreground w-7 shrink-0 text-right tabular-nums">
          {event.seq}
        </span>
      ) : null}
      {(columns?.time ?? true) ? (
        <span
          className={cn(
            'text-muted-foreground/60 w-14 shrink-0 text-right tabular-nums',
            !columns && 'event-offset',
          )}
        >
          {timeMode === 'absolute'
            ? formatAbsolute(event.ts)
            : offset !== undefined
              ? formatOffset(offset)
              : ''}
        </span>
      ) : null}
      {(columns?.session ?? true) && (runLabel || runId) ? (
        runId ? (
          <Link
            to="/sessions/$sessionId"
            params={{ sessionId: runId }}
            search={event.threadId ? { thread: event.threadId } : {}}
            onClick={(click) => click.stopPropagation()}
            className="text-muted-foreground hover:text-foreground max-w-28 shrink-0 truncate font-sans underline-offset-2 hover:underline"
            title={runId}
          >
            {runLabel ?? shortId(runId)}
          </Link>
        ) : (
          <span className="text-muted-foreground/70 max-w-28 shrink-0 truncate font-sans">
            {runLabel}
          </span>
        )
      ) : null}
      <span className="min-w-0 flex-1 truncate whitespace-nowrap">
        <span className="text-foreground">{meta.summary.title}</span>
        {(columns?.detail ?? true) && meta.summary.detail ? (
          <span className="text-muted-foreground ml-1.5">{meta.summary.detail}</span>
        ) : null}
      </span>
      {threadLabel ? (
        <span className="event-thread text-muted-foreground/70 max-w-24 shrink-0 truncate font-sans">
          {threadLabel}
        </span>
      ) : null}
    </button>
  )
}

function formatOffset(ms: number): string {
  if (ms < 1000) {
    return `+${ms}ms`
  }

  if (ms < 60_000) {
    return `+${(ms / 1000).toFixed(1)}s`
  }

  return `+${Math.floor(ms / 60_000)}m`
}

function formatAbsolute(ts: number): string {
  const date = new Date(ts)

  if (!Number.isFinite(date.getTime())) {
    return ''
  }

  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

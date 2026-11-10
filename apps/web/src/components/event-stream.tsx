import { ArrowDownToLine, Search, SlidersHorizontal, X } from 'lucide-react'
import { useCallback, useDeferredValue, useMemo, useState } from 'react'

import { cn, shortId } from '@/lib/cn'
import { eventFamilies, eventMeta, familyColor, type SessionEvent } from '@/lib/event-catalog'

import { EventInspector } from './event-inspector'
import { FollowList } from './follow-list'
import { Button } from './ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { Input } from './ui/input'
import { PanelHeader, PanelTitle } from './ui/panel'

const ROW_ESTIMATE = 26
/** Streaming deltas and effect bookkeeping drown out the story; start with them hidden. */
const DEFAULT_HIDDEN = new Set(['effect'])

export function EventStream({
  events,
  startedAt,
  threadId,
  threadLabel,
  labelFor,
  onClearThread,
  selectedSeq,
  onSelectSeq,
  toolbar = false,
}: {
  events: readonly SessionEvent[]
  startedAt?: number
  threadId?: string
  threadLabel?: string
  labelFor: (threadId: string | null) => string | undefined
  onClearThread?: () => void
  selectedSeq?: number
  onSelectSeq: (seq: number | undefined) => void
  /** When true, drop the panel title — the tab strip already names Events. */
  toolbar?: boolean
}) {
  const [query, setQuery] = useState('')
  const [follow, setFollow] = useState(true)
  const [showDeltas, setShowDeltas] = useState(false)

  const [families, setFamilies] = useState<ReadonlySet<string>>(
    () => new Set(eventFamilies.filter((family) => !DEFAULT_HIDDEN.has(family))),
  )

  const deferredQuery = useDeferredValue(query)
  const q = deferredQuery.trim().toLowerCase()

  const visible = useMemo(
    () =>
      events.filter((event) => {
        if (threadId && event.threadId !== threadId) {
          return false
        }

        if (!showDeltas && event.ephemeral) {
          return false
        }

        const meta = eventMeta(event)

        if (!families.has(meta.family)) {
          return false
        }

        return !q || meta.searchText.includes(q)
      }),
    [events, threadId, showDeltas, families, q],
  )

  const selected = useMemo(
    () =>
      selectedSeq === undefined ? undefined : events.find((event) => event.seq === selectedSeq),
    [events, selectedSeq],
  )

  const toggleFamily = useCallback((family: string) => {
    setFamilies((prev) => {
      const next = new Set(prev)

      if (next.has(family)) {
        next.delete(family)
      } else {
        next.add(family)
      }

      return next
    })
  }, [])

  const hiddenCount = eventFamilies.length - families.size + (showDeltas ? 0 : 1)
  const filtered = visible.length !== events.length

  return (
    <div className="event-stream flex h-full min-h-0 flex-col">
      <PanelHeader className="gap-1.5 pr-2">
        {toolbar ? (
          <span className="text-muted-foreground font-mono text-[11px] tabular-nums">
            {filtered ? `${visible.length}/${events.length}` : events.length}
          </span>
        ) : (
          <PanelTitle meta={filtered ? `${visible.length}/${events.length}` : events.length}>
            Events
          </PanelTitle>
        )}
        <div className={cn('relative min-w-0 flex-1 basis-24', toolbar ? '' : 'ml-auto')}>
          <Search
            aria-hidden
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
            aria-label="Search events"
            className="h-7 w-full rounded-md pl-7 text-xs"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="relative"
              aria-label="Filter event families"
            >
              <SlidersHorizontal />
              {hiddenCount > 0 ? (
                <span className="bg-foreground text-background absolute top-0.5 right-0.5 flex size-3.5 items-center justify-center rounded-full font-mono text-[8px]">
                  {hiddenCount}
                </span>
              ) : null}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Event families</DropdownMenuLabel>
            {eventFamilies.map((family) => (
              <DropdownMenuCheckboxItem
                key={family}
                checked={families.has(family)}
                onCheckedChange={() => toggleFamily(family)}
                onSelect={(event) => event.preventDefault()}
                className="font-mono"
              >
                <span
                  aria-hidden
                  className="size-1.5 rounded-full"
                  style={{ backgroundColor: familyColor(family) }}
                />
                {family}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuLabel>Live</DropdownMenuLabel>
            <DropdownMenuCheckboxItem
              checked={showDeltas}
              onCheckedChange={(checked) => setShowDeltas(checked === true)}
              onSelect={(event) => event.preventDefault()}
            >
              Ephemeral text deltas
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-pressed={follow}
          aria-label="Follow newest events"
          title="Follow newest events"
          onClick={() => setFollow(!follow)}
          className="aria-pressed:bg-accent aria-pressed:text-foreground"
        >
          <ArrowDownToLine />
        </Button>
      </PanelHeader>
      {threadId ? (
        <div className="flex h-8 shrink-0 items-center gap-2 border-b px-3 text-[11px]">
          <span className="text-muted-foreground">Thread</span>
          <span className="bg-accent text-foreground inline-flex h-5 min-w-0 items-center gap-1 rounded-sm pr-0.5 pl-1.5">
            <span className="truncate" title={threadId}>
              {threadLabel ?? shortId(threadId)}
            </span>
            {onClearThread ? (
              <button
                type="button"
                aria-label="Show all threads"
                onClick={onClearThread}
                className="text-muted-foreground hover:text-foreground hover:bg-background/60 flex size-4 items-center justify-center rounded-sm transition-colors"
              >
                <X className="size-3" />
              </button>
            ) : null}
          </span>
        </div>
      ) : null}
      <FollowList
        items={visible}
        getKey={(event) => event.id}
        estimateSize={ROW_ESTIMATE}
        overscan={16}
        follow={follow}
        onFollowChange={setFollow}
        className="min-h-24"
        itemClassName="px-1.5"
        empty={
          <p className="text-muted-foreground p-6 text-center text-xs">
            {events.length === 0 ? 'Waiting for events…' : 'No events match these filters.'}
          </p>
        }
        renderItem={(event) => (
          <EventRow
            event={event}
            startedAt={startedAt}
            threadLabel={labelFor(event.threadId)}
            selected={selectedSeq === event.seq}
            onSelectSeq={(seq) => {
              // Keep the picked row in view instead of chasing new arrivals.
              if (seq !== undefined) {
                setFollow(false)
              }

              onSelectSeq(seq)
            }}
          />
        )}
      />
      {selected ? (
        <EventInspector
          key={selected.seq}
          event={selected}
          threadLabel={labelFor(selected.threadId)}
          onClose={() => onSelectSeq(undefined)}
        />
      ) : null}
    </div>
  )
}

function EventRow({
  event,
  startedAt,
  threadLabel,
  selected,
  onSelectSeq,
}: {
  event: SessionEvent
  startedAt?: number
  threadLabel?: string
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
      <span className="text-muted-foreground w-7 shrink-0 text-right tabular-nums">
        {event.seq}
      </span>
      <span className="event-offset text-muted-foreground/60 w-12 shrink-0 text-right tabular-nums">
        {offset !== undefined ? formatOffset(offset) : ''}
      </span>
      <span className="min-w-0 flex-1 truncate whitespace-nowrap">
        <span className="text-foreground">{meta.summary.title}</span>
        {meta.summary.detail ? (
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

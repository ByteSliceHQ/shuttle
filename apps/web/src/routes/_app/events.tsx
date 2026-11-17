import { createFileRoute } from '@tanstack/react-router'
import {
  ArrowDownToLine,
  Columns3,
  LoaderCircle,
  Pause,
  Play,
  Radio,
  Search,
  SlidersHorizontal,
} from 'lucide-react'
import { useCallback, useDeferredValue, useMemo, useState } from 'react'

import { FollowList } from '@/components/follow-list'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { PanelHeader, PanelTitle } from '@/components/ui/panel'
import { eventFamilies, eventMeta, familyColor } from '@/features/events/event-catalog'
import { EventInspector } from '@/features/events/event-inspector'
import { EventRow, type EventRowColumns } from '@/features/events/event-row'
import {
  latestEventsQuery,
  useGlobalEvents,
  type GlobalEventFrame,
  type GlobalRunKind,
} from '@/features/events/global-events'
import { useWorkspace } from '@/features/workspace/workspace-context'
import { cn, shortId } from '@/lib/cn'
import { useWidthBucket } from '@/lib/use-width-bucket'

export const Route = createFileRoute('/_app/events')({
  // The log opens on the most recent events, read before the page shows. The socket that
  // follows them is opened by the page and continues from the last one.
  loader: ({ context: { queryClient } }) => queryClient.query(latestEventsQuery),
  component: GlobalEventsPage,
})

const RUN_KIND_OPTIONS: readonly { readonly id: GlobalRunKind; readonly label: string }[] = [
  { id: 'session', label: 'Sessions' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'playbook', label: 'Playbook' },
  { id: 'pulls', label: 'Pulls' },
]

const DEFAULT_HIDDEN = new Set(['effect'])
const ROW_ESTIMATE = 26

/** Below this width the log gets a column toolbar, since every column no longer fits. */
const COMPACT_BREAKPOINTS = [640] as const

const COLUMN_OPTIONS: readonly { readonly id: keyof EventRowColumns; readonly label: string }[] = [
  { id: 'seq', label: 'Seq' },
  { id: 'time', label: 'Time' },
  { id: 'session', label: 'Session' },
  { id: 'detail', label: 'Detail' },
]

/** The session name is the widest column, so a narrow log starts without it. */
const COMPACT_COLUMNS: EventRowColumns = { seq: true, time: false, session: false, detail: true }

function GlobalEventsPage() {
  return <GlobalEventLog />
}

function GlobalEventLog() {
  const workspace = useWorkspace()
  const [query, setQuery] = useState('')
  const [follow, setFollow] = useState(true)
  const [selectedCursor, setSelectedCursor] = useState<number | undefined>()
  const [widthRef, widthBucket] = useWidthBucket<HTMLDivElement>(COMPACT_BREAKPOINTS)
  const compact = widthBucket === 0
  const [compactColumns, setCompactColumns] = useState(COMPACT_COLUMNS)
  const columns = compact ? compactColumns : undefined

  const [runKinds, setRunKinds] = useState<ReadonlySet<GlobalRunKind>>(
    () => new Set(RUN_KIND_OPTIONS.map((option) => option.id)),
  )

  const [runIds, setRunIds] = useState<ReadonlySet<string>>(() => new Set())

  const [families, setFamilies] = useState<ReadonlySet<string>>(
    () => new Set(eventFamilies.filter((family) => !DEFAULT_HIDDEN.has(family))),
  )

  const serverFilter = useMemo(
    () => ({
      runKinds: [...runKinds] as GlobalRunKind[],
      runIds: runIds.size > 0 ? ([...runIds] as string[]) : undefined,
    }),
    [runKinds, runIds],
  )

  // What the loader read, for the filter the page opens with. Read once: after that the log
  // is the socket's.
  const loaded = Route.useLoaderData()
  const [seed] = useState(loaded)
  const stream = useGlobalEvents(serverFilter, seed)
  const deferredQuery = useDeferredValue(query)
  const q = deferredQuery.trim().toLowerCase()

  const sessionLabels = useMemo(() => {
    const labels = new Map<string, string>()

    for (const session of Object.values(workspace.tree.sessions)) {
      labels.set(session.runId, session.title || session.goal || shortId(session.runId))
    }

    return labels
  }, [workspace])

  const sessionOptions = useMemo(
    () =>
      Object.values(workspace.tree.sessions)
        .map((session) => ({
          runId: session.runId,
          label: session.title || session.goal || shortId(session.runId),
          folderId: session.folderId,
        }))
        .toSorted((left, right) => left.label.localeCompare(right.label)),
    [workspace],
  )

  const visible = useMemo(
    () =>
      stream.frames.filter((frame) => {
        const meta = eventMeta(frame.event)

        if (!families.has(meta.family)) {
          return false
        }

        if (!q) {
          return true
        }

        const haystack = [
          meta.searchText,
          frame.runId,
          frame.runKind,
          sessionLabels.get(frame.runId) ?? '',
        ]
          .join(' ')
          .toLowerCase()

        return haystack.includes(q)
      }),
    [stream.frames, families, q, sessionLabels],
  )

  const selected = useMemo(
    () =>
      selectedCursor === undefined
        ? undefined
        : stream.frames.find((frame) => frame.cursor === selectedCursor),
    [stream.frames, selectedCursor],
  )

  const toggleRunKind = useCallback((kind: GlobalRunKind) => {
    setRunKinds((prev) => {
      const next = new Set(prev)

      if (next.has(kind)) {
        next.delete(kind)
      } else {
        next.add(kind)
      }

      return next
    })
  }, [])

  const toggleRunId = useCallback((runId: string) => {
    setRunIds((prev) => {
      // Empty means "all sessions". The first click starts a real selection.
      if (prev.size === 0) {
        return new Set([runId])
      }

      const next = new Set(prev)

      if (next.has(runId)) {
        next.delete(runId)
      } else {
        next.add(runId)
      }

      return next
    })
  }, [])

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

  const hiddenFamilyCount = eventFamilies.length - families.size
  const hiddenKindCount = RUN_KIND_OPTIONS.length - runKinds.size
  const filtered = visible.length !== stream.frames.length

  const statusLabel = (() => {
    switch (stream.status) {
      case 'connecting':
        return 'Connecting'
      case 'reconnecting':
        return 'Reconnecting'
      case 'paused':
        return `Paused${stream.pendingCount > 0 ? ` · ${stream.pendingCount} pending` : ''}`
      case 'error':
        return stream.error ?? 'Error'
      case 'live':
        return 'Live'

      default: {
        const exhaustive: never = stream.status
        return exhaustive
      }
    }
  })()

  const searchField = (
    <div className={cn('relative min-w-0 flex-1 basis-24', !compact && 'ml-auto')}>
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
  )

  return (
    <div ref={widthRef} className="flex h-full min-h-0 flex-col">
      <PanelHeader className="gap-1.5 pr-2">
        <PanelTitle
          meta={filtered ? `${visible.length}/${stream.frames.length}` : stream.frames.length}
        >
          Events
        </PanelTitle>
        <span className="text-muted-foreground inline-flex items-center gap-1 font-mono text-[11px]">
          {stream.status === 'connecting' || stream.status === 'reconnecting' ? (
            <LoaderCircle className="size-3 animate-spin" />
          ) : (
            <Radio className="size-3" />
          )}
          {statusLabel}
        </span>
        {/* A narrow header keeps the title, count and controls; search drops to the row below. */}
        {compact ? <span aria-hidden className="flex-1" /> : searchField}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="relative"
              aria-label="Filter runs and families"
            >
              <SlidersHorizontal />
              {hiddenFamilyCount + hiddenKindCount + runIds.size > 0 ? (
                <span className="bg-foreground text-background absolute top-0.5 right-0.5 flex size-3.5 items-center justify-center rounded-full font-mono text-[8px]">
                  {hiddenFamilyCount + hiddenKindCount + (runIds.size > 0 ? 1 : 0)}
                </span>
              ) : null}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
            <DropdownMenuLabel>Run kinds</DropdownMenuLabel>
            {RUN_KIND_OPTIONS.map((option) => (
              <DropdownMenuCheckboxItem
                key={option.id}
                checked={runKinds.has(option.id)}
                onCheckedChange={() => toggleRunKind(option.id)}
                onSelect={(event) => event.preventDefault()}
              >
                {option.label}
              </DropdownMenuCheckboxItem>
            ))}
            {sessionOptions.length > 0 ? (
              <>
                <DropdownMenuLabel>Sessions</DropdownMenuLabel>
                {runIds.size > 0 ? (
                  <DropdownMenuCheckboxItem
                    checked={false}
                    onCheckedChange={() => setRunIds(new Set())}
                    onSelect={(event) => event.preventDefault()}
                  >
                    All sessions
                  </DropdownMenuCheckboxItem>
                ) : null}
                {sessionOptions.map((session) => (
                  <DropdownMenuCheckboxItem
                    key={session.runId}
                    checked={runIds.size === 0 || runIds.has(session.runId)}
                    onCheckedChange={() => toggleRunId(session.runId)}
                    onSelect={(event) => event.preventDefault()}
                  >
                    <span className="truncate" title={session.runId}>
                      {session.label}
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </>
            ) : null}
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
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-pressed={stream.paused}
          aria-label={stream.paused ? 'Resume live tail' : 'Pause live tail'}
          title={stream.paused ? 'Resume live tail' : 'Pause live tail'}
          onClick={() => (stream.paused ? stream.resume() : stream.pause())}
          className="aria-pressed:bg-accent aria-pressed:text-foreground"
        >
          {stream.paused ? <Play /> : <Pause />}
        </Button>
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
      {compact ? (
        <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
          {searchField}
          <div
            role="toolbar"
            aria-label="Columns"
            title="Columns"
            className="flex shrink-0 items-center gap-0.5 pl-1"
          >
            <Columns3 aria-hidden className="text-muted-foreground mr-0.5 size-3.5 shrink-0" />
            {COLUMN_OPTIONS.map((option) => (
              <Button
                key={option.id}
                variant="ghost"
                size="xs"
                aria-pressed={compactColumns[option.id]}
                onClick={() =>
                  setCompactColumns((prev) => ({ ...prev, [option.id]: !prev[option.id] }))
                }
                className="aria-pressed:bg-accent aria-pressed:text-foreground px-1.5"
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
      {stream.hasMoreOlder && stream.oldestCursor !== null ? (
        <div className="flex h-8 shrink-0 items-center justify-center border-b">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-[11px]"
            onClick={() => void stream.loadOlder()}
          >
            Load older
          </Button>
        </div>
      ) : null}
      <FollowList
        items={visible}
        getKey={(frame) => String(frame.cursor)}
        estimateSize={ROW_ESTIMATE}
        overscan={16}
        follow={follow}
        onFollowChange={setFollow}
        className="min-h-24"
        itemClassName="px-1.5"
        empty={
          <p className="text-muted-foreground p-6 text-center text-xs">
            {stream.frames.length === 0
              ? stream.status === 'connecting' || stream.status === 'reconnecting'
                ? 'Connecting to firehose…'
                : 'Waiting for events…'
              : 'No events match these filters.'}
          </p>
        }
        renderItem={(frame: GlobalEventFrame) => (
          <EventRow
            event={frame.event}
            runId={frame.runKind === 'session' ? frame.runId : undefined}
            runLabel={
              frame.runKind === 'session'
                ? (sessionLabels.get(frame.runId) ?? shortId(frame.runId))
                : frame.runKind
            }
            timeMode="absolute"
            columns={columns}
            selected={selectedCursor === frame.cursor}
            onSelectSeq={() => {
              if (selectedCursor === frame.cursor) {
                setSelectedCursor(undefined)
                return
              }

              setFollow(false)
              setSelectedCursor(frame.cursor)
            }}
          />
        )}
      />
      {selected ? (
        <EventInspector
          key={selected.cursor}
          event={selected.event}
          onClose={() => setSelectedCursor(undefined)}
        />
      ) : null}
    </div>
  )
}

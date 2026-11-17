import { useMutation } from '@tanstack/react-query'
import { ChevronRight, Cog, Layers, LoaderCircle, Square } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'

import { statusLabel } from '@/components/status'
import { StatusDot } from '@/components/status-dot'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/cn'
import { useApi } from '@/shuttle'
import type { ThreadNode } from '@swirls/looms/core'

import type { AgentIdentity } from './agents'
import { agentRole, isSystemAgent } from './agents'
import { resolveThreadActivityTone, type SessionActivityState } from './session-activity'

const INDENT = 14

interface FlatNode {
  readonly node: ThreadNode
  readonly depth: number
}

/**
 * The rows under `root`, in tree order. Housekeeping agents are left out when `system` is given,
 * and collected into it instead, so the tree can show them as one group.
 */
function flatten(
  root: ThreadNode | null,
  collapsed: ReadonlySet<string>,
  baseDepth = 0,
  system?: ThreadNode[],
): FlatNode[] {
  const rows: FlatNode[] = []

  if (!root) {
    return rows
  }

  const stack: FlatNode[] = [{ node: root, depth: baseDepth }]

  while (stack.length > 0) {
    const next = stack.pop()

    if (!next) {
      break
    }

    if (system && next.depth > baseDepth && isSystemAgent(next.node.definitionName)) {
      system.push(next.node)

      continue
    }

    rows.push(next)

    if (!collapsed.has(next.node.threadId)) {
      for (const child of next.node.children.toReversed()) {
        stack.push({ node: child, depth: next.depth + 1 })
      }
    }
  }

  return rows
}

export function AgentTree({
  root,
  activityState,
  identities,
  eventCounts,
  totalEventCount,
  selectedThreadId,
  showCounts = false,
  onSelect,
  stopIn,
}: {
  root: ThreadNode | null
  activityState: SessionActivityState
  identities: ReadonlyMap<string, AgentIdentity>
  eventCounts: ReadonlyMap<string, number>
  totalEventCount: number
  selectedThreadId: string | undefined
  /** Shows how many events each thread has. Only useful beside the event history. */
  showCounts?: boolean
  onSelect: (threadId: string | undefined) => void
  /** The session whose agents can be stopped from here. Left out, they cannot be. */
  stopIn?: string
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [systemOpen, setSystemOpen] = useState(false)

  // Intake, narrators and the reflector run for every message. They are most of the tree and
  // rarely what the reader came for, so they sit in one group that starts closed.
  const { rows, systemRows } = useMemo(() => {
    const system: ThreadNode[] = []
    const main = flatten(root, collapsed, 0, system)

    return {
      rows: main,
      systemRows: system.flatMap((node) => flatten(node, collapsed, 2)),
    }
  }, [root, collapsed])

  const systemCount = systemRows.filter((row) => row.depth === 2).length

  // A selected housekeeping agent stays in view even while its group is closed.
  const showSystem = systemOpen || systemRows.some((row) => row.node.threadId === selectedThreadId)

  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)

      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }

      return next
    })
  }, [])

  const renderRow = (row: FlatNode) => (
    <TreeRow
      key={row.node.threadId}
      row={row}
      activityState={activityState}
      identity={identities.get(row.node.threadId)}
      count={showCounts ? (eventCounts.get(row.node.threadId) ?? 0) : undefined}
      selected={selectedThreadId === row.node.threadId}
      collapsed={collapsed.has(row.node.threadId)}
      onToggle={toggle}
      onSelect={onSelect}
      // The session's own thread is not an agent to stop.
      stopIn={row.depth > 0 ? stopIn : undefined}
    />
  )

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-px p-2">
        <button
          type="button"
          onClick={() => onSelect(undefined)}
          className={cn(
            'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors duration-100',
            selectedThreadId === undefined
              ? 'bg-accent text-foreground'
              : 'text-muted-foreground hover:bg-accent/50',
          )}
        >
          <Layers className="size-3.5 shrink-0" />
          <span>All threads</span>
          {showCounts ? (
            <span className="text-muted-foreground ml-auto font-mono text-[10px] tabular-nums">
              {totalEventCount}
            </span>
          ) : null}
        </button>
        {rows.length === 0 ? (
          <p className="text-muted-foreground px-2 py-3 text-xs">Waiting for threads…</p>
        ) : (
          <>
            {rows.map(renderRow)}
            {systemCount > 0 ? (
              <>
                <button
                  type="button"
                  onClick={() => setSystemOpen(!showSystem)}
                  aria-expanded={showSystem}
                  title="Agents that route and answer messages, and learn from the session"
                  className="text-muted-foreground hover:bg-accent/50 hover:text-foreground relative flex h-8 w-full items-center rounded-md pr-2 text-left text-xs transition-colors duration-100"
                  style={{ paddingLeft: 4 + INDENT }}
                >
                  <span
                    aria-hidden
                    className="bg-border absolute inset-y-0 w-px"
                    style={{ left: 12 }}
                  />
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    <ChevronRight
                      className={cn(
                        'ease-snappy size-3 transition-transform duration-150',
                        showSystem && 'rotate-90',
                      )}
                    />
                  </span>
                  <span className="flex min-w-0 items-center gap-2 pl-1">
                    <Cog className="size-3.5 shrink-0" />
                    <span className="truncate font-medium">System</span>
                  </span>
                  <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums">
                    {systemCount}
                  </span>
                </button>
                {showSystem ? systemRows.map(renderRow) : null}
              </>
            ) : null}
          </>
        )}
      </div>
    </ScrollArea>
  )
}

function TreeRow({
  row,
  activityState,
  identity,
  count,
  selected,
  collapsed,
  onToggle,
  onSelect,
  stopIn,
}: {
  row: FlatNode
  activityState: SessionActivityState
  identity: AgentIdentity | undefined
  /** How many events the thread has, or nothing to leave the count out. */
  count: number | undefined
  selected: boolean
  collapsed: boolean
  onToggle: (threadId: string) => void
  onSelect: (threadId: string | undefined) => void
  /** The session this thread can be stopped in. Left out, the row has no stop button. */
  stopIn?: string
}) {
  const api = useApi()
  const { node, depth } = row
  // Stops the thread and everything beneath it.
  const stopThread = useMutation(api.sessions.stopThread.mutationOptions())
  const stopping = stopThread.isPending
  const stopError = stopThread.error?.message
  const role = identity?.role ?? agentRole(node.definitionName)
  const Icon = role.icon
  const hasChildren = node.children.length > 0
  const tone = resolveThreadActivityTone(activityState, node)
  const label = identity?.label ?? role.label

  // A thread that has already ended has nothing left to stop.
  const stoppable =
    stopIn && node.status !== 'completed' && node.status !== 'failed' && node.status !== 'cancelled'

  const stop = () => {
    if (stopIn && !stopping) {
      stopThread.mutate({ id: stopIn, threadId: node.threadId })
    }
  }

  return (
    <div
      className={cn(
        'group/row relative flex h-8 items-center rounded-md pr-2 text-xs transition-colors duration-100',
        selected ? 'bg-accent text-foreground' : 'hover:bg-accent/50',
      )}
      style={{ paddingLeft: 4 + depth * INDENT }}
      title={`${role.blurb}\n${node.kind}:${node.definitionName} · ${statusLabel(tone)}`}
    >
      {Array.from({ length: depth }, (_, level) => (
        <span
          key={level}
          aria-hidden
          className="bg-border absolute inset-y-0 w-px"
          style={{ left: 12 + level * INDENT }}
        />
      ))}
      {hasChildren ? (
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground hover:bg-background/40 flex size-4 shrink-0 items-center justify-center rounded-sm"
          onClick={() => onToggle(node.threadId)}
          aria-label={collapsed ? 'Expand thread' : 'Collapse thread'}
          aria-expanded={!collapsed}
        >
          <ChevronRight
            className={cn(
              'ease-snappy size-3 transition-transform duration-150',
              !collapsed && 'rotate-90',
            )}
          />
        </button>
      ) : (
        <span className="size-4 shrink-0" />
      )}
      <button
        type="button"
        className="flex h-full min-w-0 flex-1 items-center gap-2 pl-1 text-left"
        onClick={() => onSelect(node.threadId)}
      >
        <Icon className={cn('size-3.5 shrink-0', role.tone)} />
        <span className="min-w-0 truncate font-medium">{label}</span>
        <StatusDot status={tone} className="ml-0.5" />
        {count === undefined ? null : (
          <span
            className={cn(
              'text-muted-foreground ml-auto shrink-0 font-mono text-[10px] tabular-nums',
              // The stop button takes the count's place while the row is hovered or focused.
              stoppable && 'group-focus-within/row:invisible group-hover/row:invisible',
              stopping && 'invisible',
            )}
          >
            {count}
          </span>
        )}
      </button>
      {stoppable ? (
        <button
          type="button"
          onClick={stop}
          disabled={stopping}
          aria-label={hasChildren ? `Stop ${label} and the agents under it` : `Stop ${label}`}
          title={
            stopError ?? (hasChildren ? `Stop ${label} and the agents under it` : `Stop ${label}`)
          }
          className={cn(
            'hover:bg-destructive/15 hover:text-destructive focus-visible:ring-ring/50 absolute right-1.5 flex size-5 items-center justify-center rounded-sm outline-none focus-visible:ring-2',
            stopError ? 'text-destructive' : 'text-muted-foreground',
            stopping
              ? 'opacity-100'
              : 'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100',
          )}
        >
          {stopping ? (
            <LoaderCircle className="size-3 animate-spin" />
          ) : (
            <Square className="size-2.5 fill-current" />
          )}
        </button>
      ) : null}
    </div>
  )
}

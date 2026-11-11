import { ChevronRight, Layers } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'

import type { AgentIdentity } from '@/lib/agents'
import { agentRole } from '@/lib/agents'
import { cn } from '@/lib/cn'
import { resolveThreadActivityTone, type SessionActivityState } from '@/lib/session-activity'
import { statusLabel } from '@/lib/status'
import type { ThreadNode } from '@swirls/looms/core'

import { StatusDot } from './status-dot'
import { ScrollArea } from './ui/scroll-area'

const INDENT = 14

interface FlatNode {
  readonly node: ThreadNode
  readonly depth: number
}

function flatten(root: ThreadNode | null, collapsed: ReadonlySet<string>): FlatNode[] {
  const rows: FlatNode[] = []

  if (!root) {
    return rows
  }

  const stack: FlatNode[] = [{ node: root, depth: 0 }]

  while (stack.length > 0) {
    const next = stack.pop()

    if (!next) {
      break
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
  onSelect,
}: {
  root: ThreadNode | null
  activityState: SessionActivityState
  identities: ReadonlyMap<string, AgentIdentity>
  eventCounts: ReadonlyMap<string, number>
  totalEventCount: number
  selectedThreadId: string | undefined
  onSelect: (threadId: string | undefined) => void
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const rows = useMemo(() => flatten(root, collapsed), [root, collapsed])

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
          <span className="text-muted-foreground ml-auto font-mono text-[10px] tabular-nums">
            {totalEventCount}
          </span>
        </button>
        {rows.length === 0 ? (
          <p className="text-muted-foreground px-2 py-3 text-xs">Waiting for threads…</p>
        ) : (
          rows.map((row) => (
            <TreeRow
              key={row.node.threadId}
              row={row}
              activityState={activityState}
              identity={identities.get(row.node.threadId)}
              count={eventCounts.get(row.node.threadId) ?? 0}
              selected={selectedThreadId === row.node.threadId}
              collapsed={collapsed.has(row.node.threadId)}
              onToggle={toggle}
              onSelect={onSelect}
            />
          ))
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
}: {
  row: FlatNode
  activityState: SessionActivityState
  identity: AgentIdentity | undefined
  count: number
  selected: boolean
  collapsed: boolean
  onToggle: (threadId: string) => void
  onSelect: (threadId: string | undefined) => void
}) {
  const { node, depth } = row
  const role = identity?.role ?? agentRole(node.definitionName)
  const Icon = role.icon
  const hasChildren = node.children.length > 0
  const tone = resolveThreadActivityTone(activityState, node)

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
        <span className="min-w-0 truncate font-medium">{identity?.label ?? role.label}</span>
        <StatusDot status={tone} className="ml-0.5" />
        <span className="text-muted-foreground ml-auto shrink-0 font-mono text-[10px] tabular-nums">
          {count}
        </span>
      </button>
    </div>
  )
}

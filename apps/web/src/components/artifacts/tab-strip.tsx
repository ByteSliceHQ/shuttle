import {
  FileCode2,
  Files,
  GitCompareArrows,
  Globe,
  ListTree,
  Plus,
  SquareTerminal,
  X,
} from 'lucide-react'
import { useRef, useState, type DragEvent, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/cn'
import type { ArtifactTab, ArtifactTabKind } from '@/lib/workspace'

const KIND_ICON: Record<ArtifactTabKind, ReactNode> = {
  events: <ListTree />,
  files: <Files />,
  file: <FileCode2 />,
  changes: <GitCompareArrows />,
  terminal: <SquareTerminal />,
  browser: <Globe />,
}

export function TabStrip({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onReorder,
  onOpen,
}: {
  tabs: readonly ArtifactTab[]
  activeTabId: string | null
  onSelect: (tabId: string) => void
  onClose: (tabId: string) => void
  onReorder: (tabIds: string[]) => void
  onOpen: (kind: ArtifactTabKind) => void
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const dragOverId = useRef<string | null>(null)

  const order = tabs.map((tab) => tab.tabId)

  function dropOn(targetId: string) {
    if (!draggingId || draggingId === targetId) {
      return
    }

    const next = order.filter((id) => id !== draggingId)
    const index = next.indexOf(targetId)

    if (index < 0) {
      return
    }

    next.splice(index, 0, draggingId)
    onReorder(next)
  }

  return (
    <div className="flex h-11 shrink-0 items-center gap-0.5 border-b px-1.5">
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        {tabs.map((tab) => {
          const active = tab.tabId === activeTabId
          const closable = tab.kind !== 'events'

          return (
            <button
              key={tab.tabId}
              type="button"
              draggable
              onDragStart={(event: DragEvent) => {
                setDraggingId(tab.tabId)
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', tab.tabId)
              }}
              onDragEnd={() => {
                setDraggingId(null)
                dragOverId.current = null
              }}
              onDragOver={(event: DragEvent) => {
                event.preventDefault()
                dragOverId.current = tab.tabId
              }}
              onDrop={(event: DragEvent) => {
                event.preventDefault()
                dropOn(tab.tabId)
                setDraggingId(null)
              }}
              onClick={() => onSelect(tab.tabId)}
              onAuxClick={(event) => {
                if (event.button === 1 && closable) {
                  event.preventDefault()
                  onClose(tab.tabId)
                }
              }}
              title={tab.title}
              className={cn(
                'group relative inline-flex h-7 max-w-44 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] transition-[color,background-color,opacity] duration-100 ease-out',
                active
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                draggingId === tab.tabId && 'opacity-50',
              )}
            >
              <span className="text-muted-foreground [&_svg]:size-3.5">{KIND_ICON[tab.kind]}</span>
              <span className="min-w-0 truncate" dir="auto">
                {tab.title}
              </span>
              {closable ? (
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label={`Close ${tab.title}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    onClose(tab.tabId)
                  }}
                  className={cn(
                    'text-muted-foreground hover:text-foreground hover:bg-background/70 -mr-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm transition-opacity duration-100',
                    active ? 'opacity-70' : 'opacity-0 group-hover:opacity-70',
                  )}
                >
                  <X className="size-3" />
                </span>
              ) : null}
            </button>
          )
        })}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Open artifact" className="shrink-0">
            <Plus />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <LauncherItem kind="files" label="Files" icon={<Files />} onOpen={onOpen} />
          <LauncherItem
            kind="changes"
            label="Changes"
            icon={<GitCompareArrows />}
            onOpen={onOpen}
          />
          <LauncherItem
            kind="terminal"
            label="Terminal"
            icon={<SquareTerminal />}
            onOpen={onOpen}
          />
          <LauncherItem kind="browser" label="Browser" icon={<Globe />} onOpen={onOpen} />
          <LauncherItem kind="events" label="Events" icon={<ListTree />} onOpen={onOpen} />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function LauncherItem({
  kind,
  label,
  icon,
  onOpen,
}: {
  kind: ArtifactTabKind
  label: string
  icon: ReactNode
  onOpen: (kind: ArtifactTabKind) => void
}) {
  return (
    <DropdownMenuItem onSelect={() => onOpen(kind)}>
      {icon}
      {label}
    </DropdownMenuItem>
  )
}

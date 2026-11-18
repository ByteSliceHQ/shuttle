import { Plus, X } from 'lucide-react'
import { useRef, useState, type DragEvent } from 'react'

import { Button } from '../../components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu'
import { ScrollArea } from '../../components/ui/scroll-area'
import { cn } from '../../lib/cn'
import { hasText } from '../../lib/text'
import type { ArtifactTab, ArtifactTabKind } from '../workspace/workspace'
import { artifactTypeFor, launchableArtifactTypes, type ArtifactType } from './artifact-types'

export function TabStrip({
  tabs,
  types,
  activeTabId,
  onSelect,
  onClose,
  onReorder,
  onOpen,
}: {
  tabs: readonly ArtifactTab[]
  types: readonly ArtifactType[]
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
    if (!hasText(draggingId) || draggingId === targetId) {
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
    <div className="flex h-12 shrink-0 items-center gap-0.5 border-b px-1.5">
      <ScrollArea
        horizontal
        vertical={false}
        barClassName="h-1.5"
        className="min-w-0 flex-1"
        viewportClassName="[&>div]:flex! [&>div]:h-12 [&>div]:w-max [&>div]:items-center [&>div]:gap-0.5"
      >
        {tabs.map((tab) => {
          const active = tab.tabId === activeTabId
          const type = artifactTypeFor(types, tab.kind)
          const label = type?.tabLabel?.(tab) ?? tab.title

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
                if (event.button === 1) {
                  event.preventDefault()
                  onClose(tab.tabId)
                }
              }}
              title={label}
              className={cn(
                'group relative inline-flex h-7 max-w-44 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] transition-[color,background-color,opacity] duration-100 ease-out',
                active
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                draggingId === tab.tabId && 'opacity-50',
              )}
            >
              <span className="text-muted-foreground [&_svg]:size-3.5">{type?.icon}</span>
              <span className="min-w-0 truncate" dir="auto">
                {label}
              </span>
              <span
                role="button"
                tabIndex={-1}
                aria-label={`Close ${label}`}
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
            </button>
          )
        })}
      </ScrollArea>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Open artifact" className="shrink-0">
            <Plus />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {launchableArtifactTypes(types).map((type) => (
            <DropdownMenuItem key={type.kind} onSelect={() => onOpen(type.kind)}>
              {type.icon}
              {type.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

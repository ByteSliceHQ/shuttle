import { X } from 'lucide-react'
import type { ReactNode } from 'react'

import { JsonTree } from '@/components/json-tree'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/cn'
import { asJson } from '@swirls/looms/core'

import { eventMeta, familyColor, type SessionEvent } from './event-catalog'

function Pane({ value, children }: { value: string; children: ReactNode }) {
  return (
    <TabsContent value={value} className="min-h-0">
      <ScrollArea className="h-full">
        <div className="px-3 pt-1 pb-3">{children}</div>
      </ScrollArea>
    </TabsContent>
  )
}

export function EventInspector({
  event,
  threadLabel,
  onClose,
  className,
}: {
  event: SessionEvent
  threadLabel?: string
  onClose?: () => void
  className?: string
}) {
  const meta = eventMeta(event)

  return (
    <div className={cn('bg-sidebar flex h-[46%] min-h-44 shrink-0 flex-col border-t', className)}>
      <Tabs defaultValue="payload" className="min-h-0 flex-1 gap-0">
        <div className="flex h-10 shrink-0 items-center gap-2 pr-2 pl-3">
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: familyColor(meta.family) }}
          />
          <span className="text-muted-foreground font-mono text-[11px] tabular-nums">
            #{event.seq}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs" title={event.type}>
            {event.type}
          </span>
          <TabsList>
            <TabsTrigger value="payload">Payload</TabsTrigger>
            <TabsTrigger value="envelope">Envelope</TabsTrigger>
          </TabsList>
          {onClose ? (
            <Button variant="ghost" size="icon-sm" aria-label="Close inspector" onClick={onClose}>
              <X />
            </Button>
          ) : null}
        </div>
        {threadLabel ? (
          <p className="text-muted-foreground -mt-1 truncate px-3 pb-1.5 text-[11px]">
            on <span className="text-foreground">{threadLabel}</span>
          </p>
        ) : null}
        <Pane value="payload">
          <JsonTree value={event.payload} defaultExpandDepth={2} />
        </Pane>
        <Pane value="envelope">
          <JsonTree
            value={asJson({
              id: event.id,
              runId: event.runId,
              seq: event.seq,
              ts: event.ts,
              type: event.type,
              threadId: event.threadId,
              parentThreadId: event.parentThreadId ?? null,
              causationId: event.causationId ?? null,
              correlationId: event.correlationId ?? null,
              effectId: event.effectId ?? null,
              origin: event.origin,
              ephemeral: event.ephemeral ?? false,
            })}
          />
        </Pane>
      </Tabs>
    </div>
  )
}

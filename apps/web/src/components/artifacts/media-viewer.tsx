import { Images } from 'lucide-react'
import { useMemo, useState } from 'react'

import { MediaTile } from '@/components/media'
import { EmptyState } from '@/components/ui/panel'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { AgentIdentity } from '@/lib/agents'
import { cn } from '@/lib/cn'
import { formatBytes, mediaKind, type SessionMedia } from '@/lib/media'
import { clockTime } from '@/lib/time'

type Filter = 'all' | 'agent' | 'upload'

const FILTERS: readonly { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'agent', label: 'Made by agents' },
  { id: 'upload', label: 'Attached' },
]

/** Every file in the session in one place, newest first: what agents made and what people sent. */
export function MediaViewer({
  runId,
  media,
  identities,
}: {
  runId: string
  media: readonly SessionMedia[]
  identities: ReadonlyMap<string, AgentIdentity>
}) {
  const [filter, setFilter] = useState<Filter>('all')

  const shown = useMemo(
    () => media.filter((entry) => filter === 'all' || entry.source === filter).toReversed(),
    [media, filter],
  )

  if (media.length === 0) {
    return (
      <EmptyState icon={<Images />} title="No media yet">
        Images, video, audio and other files show up here when an agent shares one or someone
        attaches one to a message.
      </EmptyState>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b px-2.5 py-1.5">
        {FILTERS.map((option) => {
          const count =
            option.id === 'all'
              ? media.length
              : media.filter((entry) => entry.source === option.id).length

          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={filter === option.id}
              onClick={() => setFilter(option.id)}
              className={cn(
                'ease-snappy inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-[11.5px] transition-colors duration-150',
                filter === option.id
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {option.label}
              <span className="text-muted-foreground tabular-nums">{count}</span>
            </button>
          )
        })}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {shown.length === 0 ? (
          <p className="text-muted-foreground px-4 py-8 text-center text-xs">Nothing here yet.</p>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-3 p-3">
            {shown.map((entry) => (
              <li key={`${entry.asset.id}:${entry.seq}`} className="flex min-w-0 flex-col gap-1.5">
                <MediaTile runId={runId} asset={entry.asset} size="fill" />
                <div className="min-w-0 px-0.5">
                  {/* A player or a file row already carries the name. */}
                  {named(entry) ? null : (
                    <p
                      className="truncate text-[12px] font-medium"
                      dir="auto"
                      title={entry.asset.name}
                    >
                      {entry.asset.name}
                    </p>
                  )}
                  <p className="text-muted-foreground truncate text-[11px]">
                    {origin(entry, identities)} · {clockTime(entry.ts)} ·{' '}
                    <span className="tabular-nums">{formatBytes(entry.asset.size)}</span>
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  )
}

function named(entry: SessionMedia): boolean {
  const kind = mediaKind(entry.asset.mediaType)

  return kind !== 'image' && kind !== 'video'
}

function origin(entry: SessionMedia, identities: ReadonlyMap<string, AgentIdentity>): string {
  if (entry.source === 'upload') {
    return entry.authorName ? `Attached by ${entry.authorName}` : 'Attached'
  }

  const label = entry.threadId ? identities.get(entry.threadId)?.label : undefined

  return label ? `Made by ${label}` : 'Made by an agent'
}

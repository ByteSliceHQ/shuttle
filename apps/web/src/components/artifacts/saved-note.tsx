import { Moon } from 'lucide-react'

import type { SandboxSource } from '@/lib/sandbox'
import { fullDateTime, relativeTime } from '@/lib/time'
import { useNow } from '@/lib/use-now'

/**
 * Says where a tab's contents came from when that is not the running sandbox: the session's work
 * as it was last saved, shown while the sandbox that holds it is asleep. Renders nothing for live
 * contents.
 */
export function SavedNote({ source }: { source: SandboxSource }) {
  const now = useNow()

  if (source.source !== 'saved') {
    return null
  }

  return (
    <div
      className="text-muted-foreground flex h-7 shrink-0 items-center gap-1.5 border-b px-3 text-[11px]"
      title={source.savedAt ? fullDateTime(source.savedAt) : undefined}
    >
      <Moon className="size-3 shrink-0" />
      <span className="min-w-0 truncate">
        {source.savedAt ? `Saved ${relativeTime(source.savedAt, now)}` : 'Saved copy'}
        {' · the sandbox is asleep'}
      </span>
    </div>
  )
}

/** What an empty tab says when the sandbox is asleep and nothing was saved. */
export const ASLEEP_MESSAGE =
  'The sandbox for this session is asleep and no saved copy exists yet. Send a message to wake it.'

import { Link } from '@tanstack/react-router'
import { GitPullRequest, MoreHorizontal } from 'lucide-react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { resolveSessionIndicator } from '@/features/sessions/session-activity'
import { cn } from '@/lib/cn'
import { compactRelativeTime, fullDateTime } from '@/lib/time'

import { ActivityDot } from './activity-dot'

/** Hidden until the row is hovered or focused; always shown on touch, where hover never fires. */
export const revealOnRowHover =
  'opacity-0 transition-opacity duration-100 group-hover/row:opacity-100 group-has-[:focus-visible]/row:opacity-100 data-[state=open]:opacity-100 has-data-[state=open]:opacity-100 pointer-coarse:opacity-100'

/** Trailing metadata yields its slot to the row's actions. */
export const yieldOnRowHover =
  'transition-opacity duration-100 group-hover/row:opacity-0 group-has-[:focus-visible]/row:opacity-0 group-has-data-[state=open]/row:opacity-0 pointer-coarse:hidden'

export function sidebarRowClass(active: boolean) {
  return cn(
    'group/row relative flex h-8 items-center rounded-md text-[12.5px] transition-colors duration-100',
    active
      ? 'bg-accent text-foreground'
      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
  )
}

export function SessionRow({
  runId,
  title,
  activity,
  status,
  unread,
  updatedAt,
  now,
  active,
  dimmed,
  pullCount = 0,
  onRename,
  onArchive,
}: {
  runId: string
  title: string
  activity: string
  status: string
  unread?: boolean
  updatedAt: number
  now: number
  active: boolean
  dimmed?: boolean
  /** Open PRs this session authored. */
  pullCount?: number
  onRename?: () => void
  onArchive?: () => void
}) {
  const hasMenu = Boolean(onRename || onArchive)
  const tone = resolveSessionIndicator({ activity, status, unread })
  const needsAttention = !active && (tone === 'needs_input' || tone === 'ready')

  return (
    <div className={cn(sidebarRowClass(active), 'float-in', dimmed && 'opacity-60')}>
      <Link
        to="/sessions/$sessionId"
        params={{ sessionId: runId }}
        title={title}
        className="focus-visible:ring-ring/50 flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md pr-1 pl-1.5 outline-none focus-visible:ring-2"
      >
        <ActivityDot tone={tone} />
        <span
          className={cn('min-w-0 flex-1 truncate', needsAttention && 'text-foreground/90')}
          dir="auto"
        >
          {title}
        </span>
        {pullCount > 0 ? (
          <span
            title={`${pullCount} open pull ${pullCount === 1 ? 'request' : 'requests'}`}
            className="text-muted-foreground inline-flex shrink-0 items-center gap-0.5 font-mono text-[10px] tabular-nums"
          >
            <GitPullRequest aria-hidden className="size-3" />
            {pullCount}
            <span className="sr-only">open pull {pullCount === 1 ? 'request' : 'requests'}</span>
          </span>
        ) : null}
      </Link>
      <div className="relative mr-1 flex h-6 w-8 shrink-0 items-center justify-end">
        <time
          dateTime={new Date(updatedAt).toISOString()}
          title={fullDateTime(updatedAt)}
          className={cn(
            'text-muted-foreground font-mono text-[10px] tabular-nums',
            hasMenu && yieldOnRowHover,
          )}
        >
          {compactRelativeTime(updatedAt, now)}
        </time>
        {hasMenu ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`Actions for ${title}`}
                className={cn(
                  'text-muted-foreground hover:text-foreground hover:bg-accent absolute inset-y-0 right-0 flex w-6 items-center justify-center rounded-sm outline-none focus-visible:opacity-100',
                  revealOnRowHover,
                )}
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-36">
              {onRename ? <DropdownMenuItem onSelect={onRename}>Rename</DropdownMenuItem> : null}
              {onArchive ? <DropdownMenuItem onSelect={onArchive}>Archive</DropdownMenuItem> : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  )
}

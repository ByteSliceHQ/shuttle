import {
  ArrowLeft,
  Check,
  ChevronRight,
  Copy,
  Ellipsis,
  Folder as FolderIcon,
  GitPullRequest,
  PanelBottom,
  Search,
} from 'lucide-react'
import { Fragment, useMemo, useState, type ReactNode } from 'react'

import { statusClass, statusLabel } from '@/components/status'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Kbd } from '@/components/ui/panel'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  authoredPullsForSession,
  pullInbox,
  reviewedPullForSession,
  usePullsRunId,
  type PullInboxState,
} from '@/features/pulls/pulls'
import { cn, shortId } from '@/lib/cn'
import { Link } from '@/shuttle'
import { type LoomsConnectionStatus, useProjection, useRunStore } from '@swirls/looms/react'

import { OpenPullRequestButton } from './open-pull-request'
import { useSession } from './session'
import type { PublishedPull } from './session-feed'
import {
  EVENTS_SHORTCUT,
  PALETTE_SHORTCUT,
  shortcutLabel,
  type PaneShortcut,
} from './session-panes'
import { SessionPlace } from './session-place'
import { SessionPrPills } from './session-pr-pills'
import { SessionShare } from './session-share'

/** A header button that shows or hides one of the session's panes, with its shortcut on hover. */
export function PaneToggle({
  label,
  shortcut,
  open,
  onToggle,
  align = 'end',
  children,
}: {
  label: string
  shortcut: Pick<PaneShortcut, 'key' | 'shift'>
  open: boolean
  onToggle: () => void
  align?: 'start' | 'end'
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-pressed={open}
          onClick={onToggle}
          className="aria-pressed:bg-accent aria-pressed:text-foreground"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align={align}>
        <span className="inline-flex items-center gap-1.5">
          {open ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          <Kbd>{shortcutLabel(shortcut)}</Kbd>
        </span>
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * What the session is doing, in the title bar. The bar leaves it out while idle: nothing to
 * report is the resting state, and a badge for it is noise.
 */
function SessionStatusLine({
  status,
  onShowAgents,
}: {
  status: string
  /** Opens the agents pane, where there is room for one. */
  onShowAgents?: () => void
}) {
  const body = (
    <>
      <StatusDot status={status} />
      <span className="hidden @md:inline">{statusLabel(status)}</span>
    </>
  )

  const className = cn(
    'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11.5px] font-medium whitespace-nowrap',
    statusClass(status),
  )

  return onShowAgents ? (
    <button
      type="button"
      onClick={onShowAgents}
      aria-label={`${statusLabel(status)}. Show agents`}
      title={`${statusLabel(status)}. Show agents`}
      className={cn(
        className,
        'ease-snappy transition-[background-color,transform] duration-150 outline-none hover:bg-current/10 focus-visible:bg-current/10 active:scale-[0.97]',
      )}
    >
      {body}
    </button>
  ) : (
    <span className={className} title={statusLabel(status)}>
      {body}
    </span>
  )
}

/**
 * The session's name and what it produced, at the top of the conversation. It has no border
 * and shares the panel header height (and the app sidebar's top bar), so it reads as part of
 * the conversation and lines up with the panes beside it.
 */
export function SessionHeader({
  leading,
  trailing,
  onShowAgents,
}: {
  /** Sits before the title, such as the control that brings back a closed agents pane. */
  leading?: ReactNode
  /** Sits at the far end, such as the control that shows or hides the artifacts pane. */
  trailing?: ReactNode
  /** Makes the status a button that shows the agents, where the arrangement has room for them. */
  onShowAgents?: () => void
}) {
  const {
    runId,
    title,
    folder,
    feed,
    status,
    summary,
    labelFor,
    inspect,
    threadPath: viewPath,
    openThread,
    leaveThread,
    panes,
  } = useSession()

  const [copied, setCopied] = useState(false)
  const pullsStore = useRunStore(usePullsRunId())
  const inbox = useProjection(pullsStore, pullInbox)

  const sessionPulls = useMemo(
    () => mergeSessionPulls(feed.publishedPulls, inbox, runId),
    [feed.publishedPulls, inbox, runId],
  )

  const reviewed = useMemo(() => reviewedPullForSession(inbox, runId), [inbox, runId])

  // The title only ever truncates, so its length never moves the controls. As the bar narrows
  // the folder goes first, then the status and connection labels, then all but one avatar. The
  // title, the menu and the artifacts toggle stay to the end.
  return (
    <header className="@container grid h-12 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-2">
      <div className="flex min-w-0 items-center gap-1.5">
        {leading}
        <div className="flex min-w-0 items-center gap-1.5 pl-1">
          {folder ? (
            <>
              <Link
                to={{ page: 'folder', folderId: folder.folderId }}
                title={folder.name}
                className="text-muted-foreground hover:text-foreground hidden max-w-24 shrink-0 items-center gap-1.5 text-[12px] transition-colors duration-100 @xl:inline-flex @4xl:max-w-40"
              >
                <FolderIcon className="size-3.5 shrink-0" />
                <span className="truncate" dir="auto">
                  {folder.name}
                </span>
              </Link>
              <span aria-hidden className="text-muted-foreground/50 hidden text-[12px] @xl:inline">
                /
              </span>
            </>
          ) : null}
          {viewPath.length === 0 ? (
            <h1 className="min-w-0 truncate text-[13px] font-medium" dir="auto" title={title}>
              {title}
            </h1>
          ) : (
            <ThreadBreadcrumb
              title={title}
              path={viewPath}
              labelFor={labelFor}
              onOpenThread={openThread}
              onLeave={leaveThread}
            />
          )}
        </div>
      </div>
      <div className="flex items-center gap-0.5">
        {reviewed ? (
          <a
            href={reviewed.url}
            target="_blank"
            rel="noreferrer"
            title={`Reviewing ${reviewed.fullName}#${reviewed.number}: ${reviewed.title}\n${reviewed.headRef} → ${reviewed.baseRef}`}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex max-w-52 shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-colors duration-100 outline-none focus-visible:ring-2"
          >
            <GitPullRequest className="size-3 shrink-0" />
            <span className="min-w-0 truncate">
              Reviewing <span className="font-mono">#{reviewed.number}</span>
            </span>
          </a>
        ) : null}
        <SessionPrPills pulls={sessionPulls} labelFor={labelFor} onInspect={inspect} />
        {folder && folder.repos.length > 0 && !reviewed ? (
          <OpenPullRequestButton
            runId={runId}
            feed={feed}
            hasPulls={sessionPulls.length > 0}
            working={status === 'working' || status === 'running'}
          />
        ) : null}
        <ConnectionIndicator connection={summary.connection} />
        {status === 'idle' ? null : (
          <SessionStatusLine status={status} onShowAgents={onShowAgents} />
        )}
        <SessionPlace
          key={`place:${runId}`}
          runId={runId}
          working={status === 'working' || status === 'running'}
        />
        <SessionShare key={runId} runId={runId} />
        <DropdownMenu onOpenChange={(open) => !open && setCopied(false)}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="More session actions">
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem onSelect={() => panes.setPalette(true)}>
              <Search />
              Commands
              <Kbd className="ml-auto">{shortcutLabel(PALETTE_SHORTCUT)}</Kbd>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => panes.setEvents(!panes.events)}>
              <PanelBottom />
              {panes.events ? 'Hide event history' : 'Show event history'}
              <Kbd className="ml-auto">{shortcutLabel(EVENTS_SHORTCUT)}</Kbd>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={(event) => {
                // Stay open long enough to show that it copied.
                event.preventDefault()
                void navigator.clipboard.writeText(runId).then(() => setCopied(true))
              }}
            >
              {copied ? <Check className="text-status-completed" /> : <Copy />}
              {copied ? 'Copied' : 'Copy run ID'}
              <span className="text-muted-foreground ml-auto font-mono text-[10px]">
                {shortId(runId)}
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {trailing}
      </div>
    </header>
  )
}

/**
 * Where the open timeline sits: the session, the agents above it, then the agent itself. Each
 * step but the last goes back to that level.
 */
function ThreadBreadcrumb({
  title,
  path,
  labelFor,
  onOpenThread,
  onLeave,
}: {
  title: string
  path: readonly string[]
  labelFor: (threadId: string | null) => string | undefined
  onOpenThread: (threadId: string | undefined) => void
  onLeave: () => void
}) {
  const crumbClass =
    'text-muted-foreground hover:text-foreground min-w-0 truncate text-[13px] transition-colors duration-100'

  return (
    <nav aria-label="Open thread" className="flex min-w-0 items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Back" onClick={onLeave}>
            <ArrowLeft />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start">
          <span className="inline-flex items-center gap-1.5">
            Back <Kbd>Esc</Kbd>
          </span>
        </TooltipContent>
      </Tooltip>
      <button
        type="button"
        onClick={() => onOpenThread(undefined)}
        title={title}
        dir="auto"
        className={cn(crumbClass, 'hidden max-w-48 shrink @lg:block')}
      >
        {title}
      </button>
      {path.map((threadId, index) => {
        const last = index === path.length - 1
        const label = labelFor(threadId) ?? 'Agent'

        return (
          <Fragment key={threadId}>
            <ChevronRight
              aria-hidden
              className={cn(
                'text-muted-foreground/60 size-3 shrink-0',
                // The first separator follows the title, which is hidden where space is short.
                index === 0 && 'hidden @lg:block',
                !last && index > 0 && 'hidden @2xl:block',
              )}
            />
            {last ? (
              <h1 className="min-w-0 truncate text-[13px] font-medium">{label}</h1>
            ) : (
              <button
                type="button"
                onClick={() => onOpenThread(threadId)}
                className={cn(crumbClass, 'hidden shrink-0 @2xl:block')}
              >
                {label}
              </button>
            )}
          </Fragment>
        )
      })}
    </nav>
  )
}

function mergeSessionPulls(
  published: readonly PublishedPull[],
  inbox: PullInboxState,
  runId: string,
): PublishedPull[] {
  const byKey = new Map<string, PublishedPull>()

  for (const pull of authoredPullsForSession(inbox, runId)) {
    byKey.set(`${pull.fullName}#${pull.number}`, pull)
  }

  for (const pull of published) {
    const key = `${pull.fullName}#${pull.number}`
    const existing = byKey.get(key)

    byKey.set(key, {
      ...pull,
      threadId: pull.threadId ?? existing?.threadId,
      stack: pull.stack ?? existing?.stack,
    })
  }

  return [...byKey.values()]
}

/** Silent while live; only a degraded connection earns header space. */
function ConnectionIndicator({ connection }: { connection: LoomsConnectionStatus }) {
  switch (connection) {
    case 'live':
      return null
    case 'connecting':
    case 'reconnecting':
      return (
        <span
          title={connection === 'connecting' ? 'Connecting' : 'Reconnecting'}
          className="text-status-waiting inline-flex shrink-0 items-center gap-1.5 px-1 text-[11px]"
        >
          <span className="bg-status-waiting size-1.5 animate-pulse rounded-full" />
          <span className="hidden @md:inline">
            {connection === 'connecting' ? 'Connecting' : 'Reconnecting'}
          </span>
        </span>
      )

    default: {
      const exhaustive: never = connection
      return exhaustive
    }
  }
}

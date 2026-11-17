import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { GitPullRequest, PanelRightClose, PanelRightOpen, RefreshCw } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'

import { api, client } from '@/api/client'
import { Button } from '@/components/ui/button'
import { PanelHeader, PanelTitle } from '@/components/ui/panel'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useFixtureMode } from '@/features/workspace/workspace-context'
import { cn } from '@/lib/cn'
import type { FolderSyncReport } from '@shuttle/api'
import { useProjection, useRunStore } from '@swirls/looms/react'

import { hugePullInbox, worstCasePullInbox, worstCaseSyncReport } from './pull-fixtures'
import { PullInboxList, summarizeAccess } from './pull-inbox-list'
import { setPullInboxCollapsed, usePullInboxCollapsed } from './pull-inbox-pref'
import {
  attentionPullCount,
  emptyPullInbox,
  pullInbox,
  pullsForFolder,
  usePullsRunId,
  type PullInboxState,
  type PullInboxSummary,
} from './pulls'

export interface PullInboxData {
  readonly folderId: string
  /** Repos the inbox covers, in folder order. */
  readonly repos: readonly string[]
  readonly pulls: readonly PullInboxSummary[]
  readonly attention: number
  /** What GitHub let the last sync see; null until the first sync answers. */
  readonly report: FolderSyncReport | null
  readonly syncing: boolean
  readonly canSync: boolean
  readonly sync: () => void
}

/**
 * Folder PRs from the live pulls run (or a fixture), synced with GitHub when the folder opens.
 *
 * The pull requests themselves arrive on the pulls run's event stream. What the sync answers
 * with is the report of what GitHub let it see, and that is what is kept here: asking for it is
 * what makes the Worker fetch.
 */
export function usePullInbox(folderId: string, repoNames: readonly string[]): PullInboxData {
  const [fixtureMode] = useFixtureMode()
  const store = useRunStore(usePullsRunId())
  const liveInbox = useProjection(store, pullInbox)
  const live = fixtureMode === 'live'

  // Keyed by the repositories as well as the folder, so linking or unlinking one syncs again.
  // GitHub is asked once per opening: a sync that fails is not tried again behind the person's
  // back, and coming back to the window does not start one. The button does.
  const sync = useQuery({
    queryKey: [...api.workspace.pulls.sync.queryKey({ input: { folderId } }), repoNames],
    queryFn: () => client.workspace.pulls.sync({ folderId }),
    enabled: live && repoNames.length > 0,
    // The last report stays up while the repositories change under it.
    placeholderData: keepPreviousData,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })

  const liveReport = sync.data?.folderId === folderId ? sync.data : null

  const inbox: PullInboxState = useMemo(() => {
    switch (fixtureMode) {
      case 'worst':
        return worstCasePullInbox()
      case 'huge':
        return hugePullInbox()
      case 'empty':
        return emptyPullInbox
      case 'live':
        return liveInbox

      default: {
        const exhaustive: never = fixtureMode
        return exhaustive
      }
    }
  }, [fixtureMode, liveInbox])

  const repos = useMemo(() => (live ? repoNames : inboxRepos(inbox)), [inbox, live, repoNames])

  const pulls = useMemo(() => pullsForFolder(inbox, repos), [inbox, repos])

  const report = useMemo(
    () => (fixtureMode === 'worst' ? worstCaseSyncReport(folderId) : live ? liveReport : null),
    [fixtureMode, folderId, live, liveReport],
  )

  return {
    folderId,
    repos,
    pulls,
    attention: attentionPullCount(pulls),
    report,
    syncing: sync.isFetching,
    canSync: live,
    sync() {
      if (live && !sync.isFetching) {
        void sync.refetch()
      }
    },
  }
}

/** Fixture PRs live on fixture repos, so fixture mode shows all of them. */
function inboxRepos(inbox: PullInboxState): string[] {
  return [...new Set(Object.values(inbox.pulls).map((pull) => pull.fullName))].toSorted()
}

/** Docked to the right of the folder page; collapses to a rail that keeps the count visible. */
export function PullInboxPanel({ data }: { data: PullInboxData }) {
  const collapsed = usePullInboxCollapsed()

  return (
    <aside
      aria-label="Pull requests"
      className={cn(
        'pull-inbox bg-sidebar h-full shrink-0 overflow-hidden border-l',
        collapsed ? 'w-11' : 'w-[22rem]',
      )}
    >
      {collapsed ? (
        <CollapsedRail data={data} />
      ) : (
        <div className="pull-inbox-layer flex h-full w-[22rem] flex-col">
          <InboxHeader data={data}>
            <IconAction label="Collapse" onClick={() => setPullInboxCollapsed(true)}>
              <PanelRightClose />
            </IconAction>
          </InboxHeader>
          <PullInboxList data={data} />
        </div>
      )}
    </aside>
  )
}

function CollapsedRail({ data }: { data: PullInboxData }) {
  const { attention } = data
  const blocked = summarizeAccess(data.report) !== null

  const label = [
    'Show pull requests',
    attention > 0 ? `${attention} need attention` : `${data.pulls.length} open`,
    blocked ? 'some repositories could not be read' : null,
  ]
    .filter(Boolean)
    .join(', ')

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => setPullInboxCollapsed(false)}
      className="pull-inbox-layer text-muted-foreground hover:text-foreground hover:bg-accent/30 focus-visible:bg-accent/40 flex h-full w-11 flex-col items-center transition-colors duration-100 outline-none"
    >
      <span className="flex h-12 w-full shrink-0 items-center justify-center border-b">
        <PanelRightOpen className="size-3.5" />
      </span>
      <span className="relative mt-3.5">
        <GitPullRequest className="size-3.5" />
        {attention > 0 ? (
          <span className="bg-brand text-brand-foreground absolute -top-2 -right-2.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-1 font-mono text-[9px] font-semibold tabular-nums">
            {attention > 99 ? '99+' : attention}
          </span>
        ) : null}
      </span>
      <span className="mt-3 text-[11px] font-medium tracking-wide [writing-mode:vertical-rl]">
        Pull requests
      </span>
      {blocked ? <span className="bg-status-waiting mt-2.5 size-1.5 rounded-full" /> : null}
    </button>
  )
}

/** Below the wide breakpoint there is no room to dock, so the same inbox opens as a sheet. */
export function PullInboxSheetButton({ data }: { data: PullInboxData }) {
  const [open, setOpen] = useState(false)

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button variant="ghost" size="xs" onClick={() => setOpen(true)}>
        <GitPullRequest />
        Pull requests
        {data.attention > 0 ? (
          <span className="bg-brand/15 text-brand rounded-full px-1.5 font-mono text-[10px] tabular-nums">
            {data.attention}
          </span>
        ) : null}
      </Button>
      <SheetContent className="bg-sidebar">
        <SheetTitle className="sr-only">Pull requests</SheetTitle>
        <InboxHeader data={data} className="pr-12" />
        <PullInboxList data={data} />
      </SheetContent>
    </Sheet>
  )
}

function InboxHeader({
  data,
  className,
  children,
}: {
  data: PullInboxData
  className?: string
  children?: ReactNode
}) {
  return (
    <PanelHeader className={cn('pr-2 pl-3.5', className)}>
      <PanelTitle meta={data.pulls.length > 0 ? data.pulls.length.toLocaleString() : undefined}>
        Pull requests
      </PanelTitle>
      <div className="ml-auto flex items-center gap-0.5">
        {data.canSync ? (
          <IconAction label={data.syncing ? 'Syncing…' : 'Sync with GitHub'} onClick={data.sync}>
            <RefreshCw className={cn(data.syncing && 'animate-spin')} />
          </IconAction>
        ) : null}
        {children}
      </div>
    </PanelHeader>
  )
}

function IconAction({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={label} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

import {
  ArrowUpRight,
  Bot,
  ChevronRight,
  GitPullRequest,
  Layers,
  Search,
  TriangleAlert,
} from 'lucide-react'
import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'

import type { FolderSyncReport, RepoSyncReport } from '@shuttle/api'

import { cn } from '../../lib/cn'
import { compactRelativeTime, fullDateTime } from '../../lib/time'
import { useNow } from '../../lib/use-now'
import { useWorkspaceSessions } from '../workspace/workspace-context'
import { LinkedSessionLink, useSessionTitle } from './linked-session'
import { PullDetailSheet } from './pull-detail-sheet'
import { CheckGlyph, DiffStat, laneTone, RepoDot, repoShortName } from './pull-glyphs'
import type { PullInboxData } from './pull-inbox'
import {
  authorRunId,
  groupPullsByLane,
  PULL_LANES,
  pullKey,
  stacksOf,
  type InboxEntry,
  type PullInboxSummary,
  type PullLaneId,
  type PullStack,
} from './pulls'
import { StackLadder } from './stack-ladder'

const FILTER_THRESHOLD = 8
/** Long lanes show their freshest rows first; the rest wait behind "Show more". */
const LANE_PREVIEW = 20

export interface AccessSummary {
  readonly blocked: readonly string[]
  readonly failed: readonly RepoSyncReport[]
  readonly missing: readonly string[]
  readonly settingsUrl: string | null
}

/** What the last sync could not see, or null when GitHub gave us everything. */
export function summarizeAccess(report: FolderSyncReport | null): AccessSummary | null {
  if (!report) {
    return null
  }

  const blocked = report.repos.filter((repo) => repo.status === 'forbidden')
  const failed = report.repos.filter((repo) => repo.status === 'failed')

  // Only surface access UI when sync actually failed. Missing App scopes alone
  // are fine when a user token (or other path) still filled the inbox.
  if (blocked.length === 0 && failed.length === 0) {
    return null
  }

  const missing = [...new Set(report.installations.flatMap((entry) => entry.missingPermissions))]
  const install = report.installations.find((entry) => entry.missingPermissions.length > 0)

  return {
    blocked: blocked.map((repo) => repo.fullName),
    failed,
    missing,
    settingsUrl: install?.settingsUrl || null,
  }
}

function matchesFilter(pull: PullInboxSummary, query: string): boolean {
  return (
    pull.title.toLowerCase().includes(query) ||
    pull.fullName.toLowerCase().includes(query) ||
    pull.author.login.toLowerCase().includes(query) ||
    String(pull.number).includes(query)
  )
}

function entryCount(entries: readonly InboxEntry[]): number {
  return entries.reduce((sum, entry) => {
    switch (entry.kind) {
      case 'pull':
        return sum + 1
      case 'changeset':
        return sum + entry.pulls.length
      case 'stack':
        return sum + entry.lanePulls.length

      default: {
        const exhaustive: never = entry
        void exhaustive
        return sum
      }
    }
  }, 0)
}

function toggled<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(set)

  if (!next.delete(value)) {
    next.add(value)
  }

  return next
}

/** `j`/`k` walk rows, Enter opens one, `o` opens it on GitHub, `/` filters. */
function onListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
  const target = event.target as HTMLElement

  if (target.tagName === 'INPUT') {
    if (event.key === 'Escape' || event.key === 'ArrowDown') {
      event.preventDefault()
      event.currentTarget.querySelector<HTMLElement>('[data-pull-row]')?.focus()
    }

    return
  }

  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-pull-row]')]
  const index = rows.indexOf(target)

  switch (event.key) {
    case 'j':
    case 'ArrowDown':
      event.preventDefault()
      rows[Math.min(rows.length - 1, index + 1)]?.focus()
      break
    case 'k':
    case 'ArrowUp':
      event.preventDefault()
      rows[Math.max(0, index - 1)]?.focus()
      break

    case 'o': {
      const url = target.dataset.url

      if (url) {
        window.open(url, '_blank', 'noopener,noreferrer')
      }

      break
    }

    case '/':
      event.preventDefault()
      event.currentTarget.querySelector<HTMLInputElement>('input[type="search"]')?.focus()
      break
    default:
      break
  }
}

export function PullInboxList({ data }: { data: PullInboxData }) {
  const now = useNow()
  const [filter, setFilter] = useState('')
  const [scope, setScope] = useState<string | null>(null)
  const [collapsedLanes, setCollapsedLanes] = useState<ReadonlySet<PullLaneId>>(new Set())
  const [expandedLanes, setExpandedLanes] = useState<ReadonlySet<PullLaneId>>(new Set())
  const [openKey, setOpenKey] = useState<string | null>(null)
  const activeRepo = scope && data.repos.includes(scope) ? scope : null
  const query = filter.trim().toLowerCase()
  const access = summarizeAccess(data.report)

  const reports = useMemo(
    () => new Map((data.report?.repos ?? []).map((report) => [report.fullName, report])),
    [data.report],
  )

  const counts = useMemo(() => {
    const map = new Map<string, number>()

    for (const pull of data.pulls) {
      map.set(pull.fullName, (map.get(pull.fullName) ?? 0) + 1)
    }

    return map
  }, [data.pulls])

  const scoped = useMemo(
    () => (activeRepo ? data.pulls.filter((pull) => pull.fullName === activeRepo) : data.pulls),
    [data.pulls, activeRepo],
  )

  const visible = useMemo(
    () => (query ? scoped.filter((pull) => matchesFilter(pull, query)) : scoped),
    [scoped, query],
  )

  const lanes = useMemo(() => groupPullsByLane(visible), [visible])

  const openPull =
    data.pulls.find((pull) => pullKey(pull.fullName, pull.number) === openKey) ?? null

  const openRunId = openPull ? authorRunId(openPull) : undefined

  const openStack = useMemo(() => {
    if (!openPull) {
      return null
    }

    return (
      stacksOf(data.pulls).find((stack) =>
        stack.layers.some(
          (layer) => layer.fullName === openPull.fullName && layer.number === openPull.number,
        ),
      ) ?? null
    )
  }, [data.pulls, openPull])

  const siblings = useMemo(() => {
    if (openStack) {
      return openStack.layers.filter((pull) => pull !== openPull)
    }

    return openRunId
      ? data.pulls.filter((pull) => pull !== openPull && authorRunId(pull) === openRunId)
      : []
  }, [data.pulls, openPull, openRunId, openStack])

  const showFilter = scoped.length > FILTER_THRESHOLD || filter !== ''
  const activeReport = activeRepo ? reports.get(activeRepo) : undefined

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onListKeyDown}>
      {data.repos.length > 1 ? (
        <RepoScope
          repos={data.repos}
          counts={counts}
          total={data.pulls.length}
          reports={reports}
          active={activeRepo}
          onSelect={setScope}
        />
      ) : null}

      {showFilter ? (
        <label className="text-muted-foreground focus-within:text-foreground flex h-9 shrink-0 items-center gap-2 border-b px-3.5 transition-colors duration-100">
          <Search className="size-3.5 shrink-0" />
          <input
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={
              activeRepo
                ? `Filter ${repoShortName(activeRepo)}`
                : `Filter ${data.pulls.length.toLocaleString()} pull requests`
            }
            aria-label="Filter pull requests"
            className="placeholder:text-muted-foreground/70 text-foreground min-w-0 flex-1 bg-transparent text-[12.5px] outline-none [&::-webkit-search-cancel-button]:hidden"
          />
          {filter ? null : <kbd className="text-muted-foreground/70 font-mono text-[10px]">/</kbd>}
        </label>
      ) : null}

      <div className="scroll-fade min-h-0 flex-1 overflow-y-auto px-1.5 pb-4">
        {access ? <AccessNotice access={access} /> : null}

        {activeReport && activeReport.status !== 'ok' ? (
          <InboxEmpty
            icon={<TriangleAlert />}
            title={`No access to ${repoShortName(activeReport.fullName)}`}
          >
            {activeReport.status === 'forbidden'
              ? 'Shuttle needs Pull requests read access on this repository.'
              : (activeReport.message ?? 'The last sync failed.')}
          </InboxEmpty>
        ) : scoped.length === 0 ? (
          <InboxEmpty title="No open pull requests">
            {activeRepo
              ? `${repoShortName(activeRepo)} has nothing open right now.`
              : 'PRs on linked repos land here as soon as GitHub reports them.'}
          </InboxEmpty>
        ) : visible.length === 0 ? (
          <InboxEmpty title="No matches">Nothing matches “{filter.trim()}”.</InboxEmpty>
        ) : (
          PULL_LANES.map((lane) => {
            const entries = lanes.get(lane.id) ?? []

            if (entries.length === 0) {
              return null
            }

            const open = !collapsedLanes.has(lane.id)
            const shown = expandedLanes.has(lane.id) ? entries : entries.slice(0, LANE_PREVIEW)
            const hidden = entryCount(entries) - entryCount(shown)

            return (
              <section key={lane.id} className="pt-1">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setCollapsedLanes((prev) => toggled(prev, lane.id))}
                  className="bg-sidebar text-muted-foreground hover:text-foreground group focus-visible:bg-accent/40 sticky top-0 z-10 flex h-8 w-full items-center gap-2 rounded-md px-2 text-[11px] font-medium transition-colors duration-100 outline-none"
                >
                  <span className={cn('size-1.5 shrink-0 rounded-full', laneTone(lane.id))} />
                  {lane.label}
                  <span className="text-muted-foreground/70 font-mono text-[10px] tabular-nums">
                    {entryCount(entries).toLocaleString()}
                  </span>
                  <ChevronRight
                    className={cn(
                      'ease-snappy ml-auto size-3 opacity-0 transition-[transform,opacity] duration-150 group-hover:opacity-100 group-focus-visible:opacity-100',
                      open && 'rotate-90',
                    )}
                  />
                </button>
                {open ? (
                  <ul className="flex flex-col">
                    {shown.map((entry) => {
                      switch (entry.kind) {
                        case 'pull':
                          return (
                            <li key={pullKey(entry.pull.fullName, entry.pull.number)}>
                              <PullRow
                                pull={entry.pull}
                                now={now}
                                showRepo={!activeRepo}
                                onOpen={setOpenKey}
                              />
                            </li>
                          )
                        case 'changeset':
                          return (
                            <li key={entry.sessionRunId}>
                              <ChangesetGroup
                                sessionRunId={entry.sessionRunId}
                                pulls={entry.pulls}
                                total={entry.total}
                                now={now}
                                showRepo={!activeRepo}
                                onOpen={setOpenKey}
                              />
                            </li>
                          )
                        case 'stack':
                          return (
                            <li key={entry.stack.key}>
                              <StackGroup
                                stack={entry.stack}
                                lanePulls={entry.lanePulls}
                                onOpen={setOpenKey}
                              />
                            </li>
                          )

                        default: {
                          const exhaustive: never = entry
                          void exhaustive
                          return null
                        }
                      }
                    })}
                    {hidden > 0 ? (
                      <li>
                        <button
                          type="button"
                          onClick={() => setExpandedLanes((prev) => toggled(prev, lane.id))}
                          className="text-muted-foreground hover:text-foreground hover:bg-accent/40 flex h-7 w-full items-center rounded-md px-2 text-[11px] transition-colors duration-100"
                        >
                          Show {hidden.toLocaleString()} more
                        </button>
                      </li>
                    ) : null}
                  </ul>
                ) : null}
              </section>
            )
          })
        )}
      </div>

      <PullDetailSheet
        folderId={data.folderId}
        pull={openPull}
        siblings={siblings}
        stack={openStack}
        onOpenPull={setOpenKey}
        onOpenChange={(open) => (open ? undefined : setOpenKey(null))}
      />
    </div>
  )
}

function StackGroup({
  stack,
  lanePulls,
  onOpen,
}: {
  stack: PullStack
  lanePulls: readonly PullInboxSummary[]
  onOpen: (key: string) => void
}) {
  const laneKeys = new Set(lanePulls.map((pull) => pullKey(pull.fullName, pull.number)))

  return (
    <div className="px-2 py-1.5">
      <StackLadder
        stack={stack}
        ghostOutsideLane={laneKeys}
        onOpenPull={(pull) => onOpen(pullKey(pull.fullName, pull.number))}
      />
    </div>
  )
}

/** Repo tabs share the row dots' colors, so a glance ties every PR to its repo. */
function RepoScope({
  repos,
  counts,
  total,
  reports,
  active,
  onSelect,
}: {
  repos: readonly string[]
  counts: ReadonlyMap<string, number>
  total: number
  reports: ReadonlyMap<string, RepoSyncReport>
  active: string | null
  onSelect: (repo: string | null) => void
}) {
  return (
    <div
      role="tablist"
      aria-label="Filter by repository"
      className="flex h-10 shrink-0 [scrollbar-width:none] items-center gap-1 overflow-x-auto border-b px-2.5 [&::-webkit-scrollbar]:hidden"
    >
      <ScopeTab active={active === null} onSelect={() => onSelect(null)} count={total}>
        All
      </ScopeTab>
      {repos.map((fullName) => {
        const report = reports.get(fullName)
        const blocked = report !== undefined && report.status !== 'ok'
        const capped = report && report.synced < report.open

        return (
          <ScopeTab
            key={fullName}
            active={active === fullName}
            onSelect={() => onSelect(active === fullName ? null : fullName)}
            count={blocked ? null : (counts.get(fullName) ?? 0)}
            title={
              blocked
                ? `${fullName}: ${report.message ?? 'sync failed'}`
                : capped
                  ? `${fullName}: showing the ${report.synced.toLocaleString()} most recently updated of ${report.open.toLocaleString()} open`
                  : fullName
            }
            leading={
              blocked ? (
                <TriangleAlert className="text-status-waiting size-3 shrink-0" />
              ) : (
                <RepoDot fullName={fullName} />
              )
            }
          >
            {repoShortName(fullName)}
          </ScopeTab>
        )
      })}
    </div>
  )
}

function ScopeTab({
  active,
  onSelect,
  count,
  title,
  leading,
  children,
}: {
  active: boolean
  onSelect: () => void
  count: number | null
  title?: string
  leading?: ReactNode
  children: ReactNode
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      title={title}
      onClick={onSelect}
      className={cn(
        'focus-visible:ring-ring/50 inline-flex h-6 max-w-44 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[11.5px] transition-colors duration-100 outline-none focus-visible:ring-2',
        active
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
      )}
    >
      {leading}
      <span className="truncate">{children}</span>
      {count === null ? null : (
        <span className="text-muted-foreground font-mono text-[10px] tabular-nums">
          {count > 999 ? '999+' : count}
        </span>
      )}
    </button>
  )
}

function listPhrase(items: readonly string[]): string {
  if (items.length <= 1) {
    return items[0] ?? ''
  }

  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

function AccessNotice({ access }: { access: AccessSummary }) {
  const title =
    access.blocked.length > 0
      ? `Can't read pull requests in ${listPhrase(access.blocked.map(repoShortName))}`
      : access.failed.length > 0
        ? `Couldn't sync ${listPhrase(access.failed.map((repo) => repoShortName(repo.fullName)))}`
        : 'Check status is hidden'

  const body =
    access.missing.length > 0
      ? `Give the GitHub App read access to ${listPhrase(access.missing)}, then approve the update on the installation.`
      : (access.failed[0]?.message ?? 'Try syncing again.')

  return (
    <div
      role="status"
      className="border-status-waiting/25 bg-status-waiting/[0.06] mx-1 mt-2 mb-1 flex gap-2.5 rounded-lg border px-3 py-2.5"
    >
      <TriangleAlert className="text-status-waiting mt-px size-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-[12px] leading-snug font-medium wrap-anywhere">{title}</p>
        <p className="text-muted-foreground mt-1 text-[11.5px] leading-relaxed">{body}</p>
        {access.settingsUrl ? (
          <a
            href={access.settingsUrl}
            target="_blank"
            rel="noreferrer"
            className="text-foreground mt-1.5 inline-flex items-center gap-0.5 text-[11.5px] font-medium underline-offset-2 hover:underline"
          >
            Installation settings
            <ArrowUpRight className="size-3" />
          </a>
        ) : null}
      </div>
    </div>
  )
}

function PullRow({
  pull,
  now,
  showRepo,
  inChangeset = false,
  onOpen,
}: {
  pull: PullInboxSummary
  now: number
  showRepo: boolean
  /** The changeset header already names the session. */
  inChangeset?: boolean
  onOpen: (key: string) => void
}) {
  const sessions = useWorkspaceSessions()

  const author =
    pull.linkedSessions.find((session) => session.role === 'author' && sessions[session.runId]) ??
    pull.linkedSessions.find((session) => session.role === 'author')

  const authorSessionTitle = useSessionTitle(author?.runId)

  return (
    <button
      type="button"
      data-pull-row
      data-url={pull.url}
      onClick={() => onOpen(pullKey(pull.fullName, pull.number))}
      className="hover:bg-accent/50 focus-visible:bg-accent/60 flex w-full flex-col gap-1 rounded-md px-2 py-2 text-left transition-colors duration-100 outline-none"
    >
      <span className="flex w-full items-start gap-2">
        <span
          dir="auto"
          title={pull.title}
          className={cn(
            'min-w-0 flex-1 truncate text-[12.5px] leading-tight',
            pull.draft ? 'text-muted-foreground' : 'text-foreground',
          )}
        >
          {pull.title}
        </span>
        <CheckGlyph rollup={pull.checkRollup} className="mt-px" />
      </span>
      <span className="text-muted-foreground flex w-full items-center gap-1.5 text-[11px]">
        {showRepo ? (
          <>
            <RepoDot fullName={pull.fullName} />
            <span className="max-w-28 shrink-0 truncate" title={pull.fullName}>
              {repoShortName(pull.fullName)}
            </span>
          </>
        ) : null}
        <span className="text-muted-foreground/70 font-mono text-[10px]">#{pull.number}</span>
        {inChangeset ? null : author ? (
          <span
            className="flex min-w-0 items-center gap-1"
            title={authorSessionTitle ? `Opened in ${authorSessionTitle}` : 'Opened by Shuttle'}
          >
            <Bot aria-label="Opened by Shuttle" className="text-brand size-3 shrink-0" />
            {authorSessionTitle ? (
              <span className="min-w-0 truncate" dir="auto">
                {authorSessionTitle}
              </span>
            ) : null}
          </span>
        ) : (
          <span className="min-w-0 truncate" title={pull.author.login}>
            {pull.author.login}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <DiffStat additions={pull.additions} deletions={pull.deletions} />
          <time
            title={fullDateTime(pull.updatedAt)}
            className="w-6 text-right font-mono text-[10px] tabular-nums"
          >
            {compactRelativeTime(pull.updatedAt, now)}
          </time>
        </span>
      </span>
    </button>
  )
}

function ChangesetGroup({
  sessionRunId,
  pulls,
  total,
  now,
  showRepo,
  onOpen,
}: {
  sessionRunId: string
  pulls: readonly PullInboxSummary[]
  total: number
  now: number
  showRepo: boolean
  onOpen: (key: string) => void
}) {
  const title = useSessionTitle(sessionRunId)

  const author = pulls
    .flatMap((pull) => pull.linkedSessions)
    .find((session) => session.role === 'author' && session.runId === sessionRunId)

  return (
    <div className="py-0.5">
      <div className="text-muted-foreground flex h-6 items-center gap-1.5 px-2 text-[11px]">
        <Layers className="size-3 shrink-0" />
        <LinkedSessionLink
          session={author ?? { runId: sessionRunId, role: 'author' }}
          className="hover:text-foreground min-w-0"
        >
          <span className="truncate" dir="auto" title={title}>
            {title ?? 'Shuttle session'}
          </span>
        </LinkedSessionLink>
        <span
          className="ml-auto shrink-0 font-mono text-[10px] tabular-nums"
          title={total > pulls.length ? `${total - pulls.length} more in other lanes` : undefined}
        >
          {total > pulls.length ? `${pulls.length} of ${total}` : pulls.length} PRs
        </span>
      </div>
      <ul className="border-border/80 ml-3 flex flex-col border-l pl-1">
        {pulls.map((pull) => (
          <li key={pullKey(pull.fullName, pull.number)}>
            <PullRow pull={pull} now={now} showRepo={showRepo} inChangeset onOpen={onOpen} />
          </li>
        ))}
      </ul>
    </div>
  )
}

function InboxEmpty({
  icon,
  title,
  children,
}: {
  icon?: ReactNode
  title: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-1.5 px-6 pt-16 text-center">
      <span className="text-muted-foreground/50 mb-1 [&_svg]:size-4">
        {icon ?? <GitPullRequest />}
      </span>
      <p className="text-[12.5px] font-medium wrap-anywhere">{title}</p>
      <p className="text-muted-foreground max-w-56 text-[11.5px] leading-relaxed">{children}</p>
    </div>
  )
}

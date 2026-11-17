import { useMutation } from '@tanstack/react-query'
import {
  Archive,
  BookOpen,
  FolderPlus,
  GitBranch,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Plus,
  Radio,
  SquarePen,
} from 'lucide-react'
import { useEffect, useEffectEvent, useMemo, useState } from 'react'
import { z } from 'zod'

import { useProjection, useRunStore } from '@swirls/looms/react'

import { ShuttleMark } from '../../components/shuttle-mark'
import { Button } from '../../components/ui/button'
import { Kbd } from '../../components/ui/panel'
import { ScrollArea } from '../../components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip'
import { cn } from '../../lib/cn'
import { useMediaQuery } from '../../lib/use-media-query'
import { useNow } from '../../lib/use-now'
import {
  Link,
  type ShuttleDestination,
  useLocation,
  useNavigate,
  useShuttleHost,
  useTenant,
} from '../../shuttle'
import {
  attentionPullCount,
  authoredPullCounts,
  pullInbox,
  pullsForFolder,
  usePullsRunId,
} from '../pulls/pulls'
import { recentSessions } from '../sessions/recent-sessions'
import {
  isSessionUnread,
  markSessionSeen,
  useSeenSessions,
  type SeenSessionsSnapshot,
} from '../sessions/seen-sessions'
import { resolveFolderIndicator, resolveSessionIndicator } from '../sessions/session-activity'
import { ActivityDot } from './activity-dot'
import { FixtureToggle } from './fixture-toggle'
import { FolderGroup } from './folder-group'
import { InlineNameInput } from './inline-name-input'
import { LinkRepoDialog } from './link-repo-dialog'
import { SessionRow } from './session-row'
import {
  createWorkspaceFolder,
  orderedFolders,
  rememberLastFolder,
  sessionsForFolder,
  type GithubInstallation,
} from './workspace'
import { useWorkspace, WorkspaceProvider, type WorkspaceValue } from './workspace-context'

const COLLAPSED_KEY = 'shuttle.sidebar-collapsed'
const EXPANDED_KEY = 'shuttle.sidebar-expanded'
const SHOW_ARCHIVED_KEY = 'shuttle.sidebar-show-archived'
const UNFILED_LIMIT = 8

function readExpanded(): Record<string, boolean> {
  try {
    return z
      .record(z.string(), z.boolean())
      .parse(JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '{}'))
  } catch {
    return {}
  }
}

/** What a host puts into the sidebar that is its own. Each is left out when not given. */
export interface SidebarSlots {
  /** Above the GitHub footer: something about where sessions run, such as this machine. */
  readonly status?: React.ReactNode
  /** At the very bottom: who is signed in, and the way out. */
  readonly account?: React.ReactNode
}

/**
 * The frame Shuttle's pages sit in: the workspace's folders and sessions down the side, and
 * the page beside them. It follows the workspace, so everything inside can read it.
 */
export function AppSidebarShell({
  children,
  status,
  account,
  background,
}: SidebarSlots & {
  children: React.ReactNode
  /** Things that draw nothing but need the workspace, such as a badge on the app's icon. */
  background?: React.ReactNode
}) {
  const { fixtures } = useShuttleHost()

  return (
    <WorkspaceProvider>
      {background}
      <div className="flex h-dvh min-h-0">
        <AppSidebar status={status} account={account} />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
      {fixtures ? <FixtureToggle /> : null}
    </WorkspaceProvider>
  )
}

function AppSidebar({ status, account }: SidebarSlots) {
  const navigate = useNavigate()
  const location = useLocation()
  // Names the page on screen, to tell whether the drawer was opened from it.
  const here = JSON.stringify(location)
  const narrow = useMediaQuery('(max-width: 767px)')
  const workspace = useWorkspace()
  const seenSnapshot = useSeenSessions()
  const activeRunId = location?.page === 'session' ? location.sessionId : null
  const activeSession = activeRunId ? workspace.tree.sessions[activeRunId] : undefined

  useEffect(() => {
    if (!activeRunId) {
      return
    }

    const latestAt = Math.max(
      Date.now(),
      activeSession?.lastCompletedAt ?? 0,
      activeSession?.updatedAt ?? 0,
    )

    markSessionSeen(activeRunId, latestAt)
  }, [activeRunId, activeSession?.lastCompletedAt, activeSession?.updatedAt])

  const [collapsedPref, setCollapsedPref] = useState(
    () => localStorage.getItem(COLLAPSED_KEY) === '1',
  )

  /** On narrow screens the drawer stays open only on the page it was opened from. */
  const [drawerPath, setDrawerPath] = useState<string | null>(null)
  const drawerOpen = narrow && drawerPath === here
  const collapsed = narrow ? !drawerOpen : collapsedPref

  function toggle() {
    if (narrow) {
      setDrawerPath(drawerOpen ? null : here)
      return
    }

    const next = !collapsedPref
    localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0')
    setCollapsedPref(next)
  }

  /** ⌘N belongs to the browser, so new session lives on ⌘⇧O. */
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    const mod = event.metaKey || event.ctrlKey
    const key = event.key.toLowerCase()

    if (mod && !event.shiftKey && key === 'b') {
      event.preventDefault()
      toggle()
    }

    if (mod && event.shiftKey && key === 'o') {
      event.preventDefault()
      void navigate({ page: 'home' })
    }

    if (key === 'escape' && drawerOpen && !event.defaultPrevented) {
      setDrawerPath(null)
    }
  })

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const rail = (
    <SidebarRail
      location={location}
      activeRunId={activeRunId}
      workspace={workspace}
      seenSnapshot={seenSnapshot}
      onExpand={toggle}
    />
  )

  if (collapsed) {
    return rail
  }

  const panel = (
    <SidebarPanel
      status={status}
      account={account}
      location={location}
      activeRunId={activeRunId}
      seenSnapshot={seenSnapshot}
      onCollapse={toggle}
    />
  )

  if (narrow) {
    return (
      <>
        {rail}
        <div
          aria-hidden
          className="drawer-scrim fixed inset-0 z-40 bg-black/50"
          onClick={() => setDrawerPath(null)}
        />
        <div
          className="drawer-in fixed inset-y-0 left-0 z-50 flex shadow-2xl shadow-black/60"
          onClick={(event) => {
            if (event.target instanceof Element && event.target.closest('a[href]')) {
              setDrawerPath(null)
            }
          }}
        >
          {panel}
        </div>
      </>
    )
  }

  return panel
}

function SidebarRail({
  location,
  activeRunId,
  workspace,
  seenSnapshot,
  onExpand,
}: {
  location: ShuttleDestination | null
  activeRunId: string | null
  workspace: WorkspaceValue
  seenSnapshot: SeenSessionsSnapshot
  onExpand: () => void
}) {
  const pullsStore = useRunStore(usePullsRunId())
  const inbox = useProjection(pullsStore, pullInbox)

  const rollup = useMemo(() => {
    const tones = Object.values(workspace.tree.sessions)
      .filter((session) => !session.archived && !workspace.tree.folders[session.folderId]?.archived)
      .map((session) =>
        resolveSessionIndicator({
          activity: session.activity,
          status: session.status,
          unread: isSessionUnread(session, { activeRunId, snapshot: seenSnapshot }),
        }),
      )

    return resolveFolderIndicator(tones)
  }, [workspace, activeRunId, seenSnapshot])

  const totalPullAttention = useMemo(() => {
    return Object.values(workspace.tree.folders)
      .filter((folder) => !folder.archived)
      .reduce(
        (sum, folder) =>
          sum +
          attentionPullCount(
            pullsForFolder(
              inbox,
              folder.repos.map((repo) => repo.fullName),
            ),
          ),
        0,
      )
  }, [workspace, inbox])

  const expandLabel = rollup
    ? `Expand sidebar · ${rollup.label}`
    : totalPullAttention > 0
      ? `Expand sidebar · ${totalPullAttention} PRs need attention`
      : 'Expand sidebar'

  return (
    <aside className="bg-sidebar flex w-12 shrink-0 flex-col items-center gap-1 border-r py-2">
      <IconTip label={expandLabel} shortcut={['⌘', 'B']} side="right">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={expandLabel}
          onClick={onExpand}
          className="relative"
        >
          <PanelLeftOpen />
          {rollup ? (
            <span className="bg-sidebar absolute -top-0.5 -right-0.5 rounded-full p-px">
              <ActivityDot tone={rollup.tone} label={rollup.label} className="size-3" />
            </span>
          ) : totalPullAttention > 0 ? (
            <span className="bg-brand text-brand-foreground absolute -top-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full text-[8px] font-semibold tabular-nums">
              {totalPullAttention > 9 ? '9+' : totalPullAttention}
            </span>
          ) : null}
        </Button>
      </IconTip>
      <div className="bg-border my-1 h-px w-5" />
      <IconTip label="New session" shortcut={['⌘', '⇧', 'O']} side="right">
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn(location?.page === 'home' && 'bg-accent text-foreground')}
          asChild
        >
          <Link to={{ page: 'home' }} aria-label="New session">
            <SquarePen />
          </Link>
        </Button>
      </IconTip>
      <IconTip label="Playbook" side="right">
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn(location?.page === 'playbook' && 'bg-accent text-foreground')}
          asChild
        >
          <Link to={{ page: 'playbook' }} aria-label="Playbook">
            <BookOpen />
          </Link>
        </Button>
      </IconTip>
      <IconTip label="Events" side="right">
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn(location?.page === 'events' && 'bg-accent text-foreground')}
          asChild
        >
          <Link to={{ page: 'events' }} aria-label="Events">
            <Radio />
          </Link>
        </Button>
      </IconTip>
      <IconTip label="Connections" side="right">
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn(location?.page === 'connections' && 'bg-accent text-foreground')}
          asChild
        >
          <Link to={{ page: 'connections' }} aria-label="Connections">
            <Plug />
          </Link>
        </Button>
      </IconTip>
    </aside>
  )
}

function SidebarPanel({
  location,
  activeRunId,
  seenSnapshot,
  onCollapse,
  status,
  account,
}: SidebarSlots & {
  location: ShuttleDestination | null
  activeRunId: string | null
  seenSnapshot: SeenSessionsSnapshot
  onCollapse: () => void
}) {
  const workspace = useWorkspace()

  return (
    <aside className="bg-sidebar flex w-[260px] shrink-0 flex-col border-r">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b pr-2 pl-3">
        <Link
          to={{ page: 'home' }}
          className="focus-visible:ring-ring/50 flex min-w-0 flex-1 items-center gap-2 rounded-md outline-none focus-visible:ring-2"
        >
          <span className="bg-brand/15 text-foreground ring-brand/25 flex size-6 shrink-0 items-center justify-center rounded-md ring-1 ring-inset">
            <ShuttleMark className="size-3.5" />
          </span>
          <span className="truncate text-[13px] font-semibold tracking-tight">Shuttle</span>
        </Link>
        <IconTip label="Collapse sidebar" shortcut={['⌘', 'B']}>
          <Button variant="ghost" size="icon-xs" aria-label="Collapse sidebar" onClick={onCollapse}>
            <PanelLeftClose />
          </Button>
        </IconTip>
      </div>

      <nav className="flex flex-col gap-px p-2">
        <SidebarNavLink
          to={{ page: 'home' }}
          icon={<SquarePen />}
          active={location?.page === 'home'}
          shortcut={['⌘', '⇧', 'O']}
        >
          New session
        </SidebarNavLink>
        <SidebarNavLink
          to={{ page: 'playbook' }}
          icon={<BookOpen />}
          active={location?.page === 'playbook'}
        >
          Playbook
        </SidebarNavLink>
        <SidebarNavLink
          to={{ page: 'events' }}
          icon={<Radio />}
          active={location?.page === 'events'}
        >
          Events
        </SidebarNavLink>
        <SidebarNavLink
          to={{ page: 'connections' }}
          icon={<Plug />}
          active={location?.page === 'connections'}
        >
          Connections
        </SidebarNavLink>
      </nav>

      <FolderTree
        workspace={workspace}
        location={location}
        activeRunId={activeRunId}
        seenSnapshot={seenSnapshot}
      />

      {status}
      <GithubFooter installations={Object.values(workspace.tree.installations)} />
      {account}
    </aside>
  )
}

function FolderTree({
  workspace,
  location,
  activeRunId,
  seenSnapshot,
}: {
  workspace: WorkspaceValue
  location: ShuttleDestination | null
  activeRunId: string | null
  seenSnapshot: SeenSessionsSnapshot
}) {
  const host = useShuttleHost()
  const { runId, tree, liveSessions } = workspace
  const navigate = useNavigate()
  const now = useNow()
  const pullsStore = useRunStore(usePullsRunId())
  const inbox = useProjection(pullsStore, pullInbox)
  const pullCounts = useMemo(() => authoredPullCounts(inbox), [inbox])
  const orgPrefix = `o-${useTenant().org.id}-`

  const [showArchived, setShowArchived] = useState(
    () => localStorage.getItem(SHOW_ARCHIVED_KEY) === '1',
  )

  const [expanded, setExpanded] = useState(readExpanded)
  const [creating, setCreating] = useState(false)
  const [linkFolderId, setLinkFolderId] = useState<string | null>(null)

  const folders = orderedFolders(tree, { includeArchived: showArchived })

  const unfiled = useMemo(
    () =>
      recentSessions()
        // This browser may have opened sessions in another organization; those are not ours.
        .filter((session) => session.runId.startsWith(orgPrefix) && !tree.sessions[session.runId])
        .slice(0, UNFILED_LIMIT),
    [tree.sessions, orgPrefix],
  )

  const linkFolder = linkFolderId ? tree.folders[linkFolderId] : undefined

  function toggleArchived() {
    const next = !showArchived
    localStorage.setItem(SHOW_ARCHIVED_KEY, next ? '1' : '0')
    setShowArchived(next)
  }

  function setFolderOpen(folderId: string, open: boolean) {
    setExpanded((prev) => {
      const next = { ...prev, [folderId]: open }
      localStorage.setItem(EXPANDED_KEY, JSON.stringify(next))
      return next
    })
  }

  const createFolder = useMutation({
    mutationFn: (name: string) => createWorkspaceFolder(host, runId, name),
    onSuccess(folderId) {
      setFolderOpen(folderId, true)
      rememberLastFolder(folderId)
      void navigate({ page: 'folder', folderId })
    },
  })

  return (
    <>
      <div className="flex h-7 shrink-0 items-center gap-0.5 pr-2 pl-3">
        <SectionHeading>Folders</SectionHeading>
        <IconTip label={showArchived ? 'Hide archived' : 'Show archived'}>
          <Button
            variant="ghost"
            size="icon-xs"
            className="aria-pressed:bg-accent aria-pressed:text-foreground ml-auto"
            aria-label="Show archived"
            aria-pressed={showArchived}
            onClick={toggleArchived}
          >
            <Archive />
          </Button>
        </IconTip>
        <IconTip label="New folder">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="New folder"
            onClick={() => setCreating(true)}
          >
            <FolderPlus />
          </Button>
        </IconTip>
      </div>

      <ScrollArea className="scroll-fade min-h-0 flex-1">
        <div className="px-1.5 pt-0.5 pb-5">
          {creating ? (
            <div className="px-1 py-0.5">
              <InlineNameInput
                initialValue="New folder"
                label="Folder name"
                commitUnchanged
                onCancel={() => setCreating(false)}
                onCommit={(name) => {
                  setCreating(false)
                  createFolder.mutate(name)
                }}
              />
            </div>
          ) : null}

          {folders.length === 0 && !creating ? (
            <div className="mx-1.5 my-1 rounded-lg border border-dashed px-3 py-3">
              <p className="text-muted-foreground text-[11.5px] leading-relaxed">
                Folders group sessions and the GitHub repos their agents can work in.
              </p>
              <Button
                variant="secondary"
                size="xs"
                className="mt-2"
                onClick={() => setCreating(true)}
              >
                <FolderPlus />
                New folder
              </Button>
            </div>
          ) : null}

          {folders.map((folder) => {
            const open = expanded[folder.folderId] ?? !folder.archived

            const pullAttention = attentionPullCount(
              pullsForFolder(
                inbox,
                folder.repos.map((repo) => repo.fullName),
              ),
            )

            return (
              <FolderGroup
                key={folder.folderId}
                runId={runId}
                folder={folder}
                sessions={sessionsForFolder(tree, folder.folderId, {
                  includeArchived: showArchived,
                })}
                open={open}
                onToggle={() => setFolderOpen(folder.folderId, !open)}
                location={location}
                activeRunId={activeRunId}
                seenSnapshot={seenSnapshot}
                now={now}
                pullAttention={pullAttention}
                pullCounts={pullCounts}
                onLinkRepo={() => setLinkFolderId(folder.folderId)}
              />
            )
          })}

          {unfiled.length > 0 ? (
            <div className="mt-4">
              <div className="flex h-7 items-center px-1.5">
                <SectionHeading>Unfiled</SectionHeading>
              </div>
              {unfiled.map((session) => {
                const live = liveSessions[session.runId]
                return (
                  <SessionRow
                    key={session.runId}
                    runId={session.runId}
                    title={session.goal}
                    activity={live?.activity ?? 'idle'}
                    status={live?.status ?? 'unknown'}
                    updatedAt={session.openedAt}
                    now={now}
                    active={activeRunId === session.runId}
                    pullCount={pullCounts.get(session.runId)}
                  />
                )
              })}
            </div>
          ) : null}
        </div>
      </ScrollArea>

      {linkFolder ? (
        <LinkRepoDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setLinkFolderId(null)
            }
          }}
          folderId={linkFolder.folderId}
          folderName={linkFolder.name}
          tree={tree}
          linked={linkFolder.repos}
        />
      ) : null}
    </>
  )
}

function GithubFooter({ installations }: { installations: readonly GithubInstallation[] }) {
  if (installations.length === 0) {
    return (
      <div className="shrink-0 border-t p-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-full justify-start px-2 text-[12.5px]"
          asChild
        >
          <a href="/github/install">
            <GitBranch />
            Connect GitHub
          </a>
        </Button>
      </div>
    )
  }

  const logins = installations.map((installation) => installation.account.login).join(', ')

  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-t pr-2 pl-3">
      <div className="flex shrink-0 -space-x-1.5">
        {installations.slice(0, 3).map((installation) => (
          <GithubAvatar key={installation.installationId} installation={installation} />
        ))}
      </div>
      <span className="text-muted-foreground min-w-0 flex-1 truncate text-[11px]" title={logins}>
        {logins}
      </span>
      <IconTip label="Add GitHub organization">
        <Button variant="ghost" size="icon-xs" aria-label="Add GitHub organization" asChild>
          <a href="/github/install?add">
            <Plus />
          </a>
        </Button>
      </IconTip>
    </div>
  )
}

function GithubAvatar({ installation }: { installation: GithubInstallation }) {
  const { login, avatarUrl } = installation.account
  const [failed, setFailed] = useState(false)

  if (!avatarUrl || failed) {
    return (
      <span
        aria-label={login}
        className="bg-accent text-foreground ring-sidebar flex size-5 items-center justify-center rounded-full text-[9px] font-medium uppercase ring-2"
      >
        {Array.from(login)[0] ?? '?'}
      </span>
    )
  }

  return (
    <img
      src={avatarUrl}
      alt={login}
      onError={() => setFailed(true)}
      className="ring-sidebar size-5 rounded-full object-cover ring-2"
    />
  )
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
      {children}
    </span>
  )
}

function SidebarNavLink({
  to,
  icon,
  active,
  shortcut,
  children,
}: {
  to: ShuttleDestination
  icon: React.ReactNode
  active: boolean
  shortcut?: readonly string[]
  children: React.ReactNode
}) {
  return (
    <Link
      to={to}
      className={cn(
        'group/nav focus-visible:ring-ring/50 flex h-8 items-center gap-2 rounded-md px-2 text-[12.5px] transition-colors duration-100 outline-none focus-visible:ring-2 [&>svg]:size-3.5 [&>svg]:shrink-0',
        active
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
      )}
    >
      {icon}
      {children}
      {shortcut ? (
        <span
          aria-hidden
          className="ml-auto flex gap-0.5 opacity-0 transition-opacity duration-100 group-hover/nav:opacity-100 pointer-coarse:hidden"
        >
          {shortcut.map((key) => (
            <Kbd key={key}>{key}</Kbd>
          ))}
        </span>
      ) : null}
    </Link>
  )
}

function IconTip({
  label,
  shortcut,
  side = 'bottom',
  children,
}: {
  label: string
  shortcut?: readonly string[]
  side?: 'top' | 'right' | 'bottom' | 'left'
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} className="flex items-center gap-2">
        {label}
        {shortcut ? (
          <span className="flex gap-0.5">
            {shortcut.map((key) => (
              <Kbd key={key}>{key}</Kbd>
            ))}
          </span>
        ) : null}
      </TooltipContent>
    </Tooltip>
  )
}

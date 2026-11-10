import { Link, useNavigate, useRouterState } from '@tanstack/react-router'
import {
  Archive,
  BookOpen,
  FolderPlus,
  GitBranch,
  Orbit,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  SquarePen,
} from 'lucide-react'
import { useEffect, useEffectEvent, useMemo, useState } from 'react'

import { FixtureToggle } from '@/components/sidebar/fixture-toggle'
import { FolderGroup } from '@/components/sidebar/folder-group'
import { InlineNameInput } from '@/components/sidebar/inline-name-input'
import { LinkRepoDialog } from '@/components/sidebar/link-repo-dialog'
import { SessionRow } from '@/components/sidebar/session-row'
import {
  useWorkspace,
  useWorkspaceError,
  WorkspaceProvider,
  type WorkspaceValue,
} from '@/components/sidebar/workspace-context'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/panel'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/cn'
import { recentSessions } from '@/lib/recent-sessions'
import { useMediaQuery } from '@/lib/use-media-query'
import { useNow } from '@/lib/use-now'
import {
  createWorkspaceFolder,
  orderedFolders,
  rememberLastFolder,
  sessionsForFolder,
  type GithubInstallation,
} from '@/lib/workspace'
import { LoomsProvider } from '@swirls/looms/react'

const COLLAPSED_KEY = 'shuttle.sidebar-collapsed'
const EXPANDED_KEY = 'shuttle.sidebar-expanded'
const SHOW_ARCHIVED_KEY = 'shuttle.sidebar-show-archived'
const UNFILED_LIMIT = 8

function readExpanded(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '{}') as Record<string, boolean>
  } catch {
    return {}
  }
}

export function AppSidebarShell({ children }: { children: React.ReactNode }) {
  return (
    <LoomsProvider endpoint="">
      <WorkspaceProvider>
        <div className="flex h-dvh min-h-0">
          <AppSidebar />
          <div className="min-w-0 flex-1">{children}</div>
        </div>
        {import.meta.env.DEV ? <FixtureToggle /> : null}
      </WorkspaceProvider>
    </LoomsProvider>
  )
}

function AppSidebar() {
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const narrow = useMediaQuery('(max-width: 767px)')

  const [collapsedPref, setCollapsedPref] = useState(
    () => localStorage.getItem(COLLAPSED_KEY) === '1',
  )

  /** On narrow screens the drawer stays open only on the page it was opened from. */
  const [drawerPath, setDrawerPath] = useState<string | null>(null)
  const drawerOpen = narrow && drawerPath === pathname
  const collapsed = narrow ? !drawerOpen : collapsedPref

  function toggle() {
    if (narrow) {
      setDrawerPath(drawerOpen ? null : pathname)
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
      void navigate({ to: '/' })
    }

    if (key === 'escape' && drawerOpen && !event.defaultPrevented) {
      setDrawerPath(null)
    }
  })

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const rail = <SidebarRail pathname={pathname} onExpand={toggle} />

  if (collapsed) {
    return rail
  }

  const panel = <SidebarPanel pathname={pathname} onCollapse={toggle} />

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

function SidebarRail({ pathname, onExpand }: { pathname: string; onExpand: () => void }) {
  return (
    <aside className="bg-sidebar flex w-12 shrink-0 flex-col items-center gap-1 border-r py-2">
      <IconTip label="Expand sidebar" shortcut={['⌘', 'B']} side="right">
        <Button variant="ghost" size="icon-sm" aria-label="Expand sidebar" onClick={onExpand}>
          <PanelLeftOpen />
        </Button>
      </IconTip>
      <div className="bg-border my-1 h-px w-5" />
      <IconTip label="New session" shortcut={['⌘', '⇧', 'O']} side="right">
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn(pathname === '/' && 'bg-accent text-foreground')}
          asChild
        >
          <Link to="/" aria-label="New session">
            <SquarePen />
          </Link>
        </Button>
      </IconTip>
      <IconTip label="Playbook" side="right">
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn(pathname === '/playbook' && 'bg-accent text-foreground')}
          asChild
        >
          <Link to="/playbook" aria-label="Playbook">
            <BookOpen />
          </Link>
        </Button>
      </IconTip>
    </aside>
  )
}

function SidebarPanel({ pathname, onCollapse }: { pathname: string; onCollapse: () => void }) {
  const workspace = useWorkspace()
  const error = useWorkspaceError()

  return (
    <aside className="bg-sidebar flex w-[260px] shrink-0 flex-col border-r">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b pr-2 pl-3">
        <Link
          to="/"
          className="focus-visible:ring-ring/50 flex min-w-0 flex-1 items-center gap-2 rounded-md outline-none focus-visible:ring-2"
        >
          <span className="bg-brand/15 text-brand ring-brand/25 flex size-6 shrink-0 items-center justify-center rounded-md ring-1 ring-inset">
            <Orbit className="size-3.5" />
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
          to="/"
          icon={<SquarePen />}
          active={pathname === '/'}
          shortcut={['⌘', '⇧', 'O']}
        >
          New session
        </SidebarNavLink>
        <SidebarNavLink to="/playbook" icon={<BookOpen />} active={pathname === '/playbook'}>
          Playbook
        </SidebarNavLink>
      </nav>

      {workspace ? (
        <FolderTree workspace={workspace} pathname={pathname} />
      ) : (
        <FolderTreeSkeleton error={error} />
      )}

      <GithubFooter installations={workspace ? Object.values(workspace.tree.installations) : []} />
    </aside>
  )
}

function FolderTree({ workspace, pathname }: { workspace: WorkspaceValue; pathname: string }) {
  const { runId, tree } = workspace
  const navigate = useNavigate()
  const now = useNow()

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
        .filter((session) => !tree.sessions[session.runId])
        .slice(0, UNFILED_LIMIT),
    [tree.sessions],
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

  async function createFolder(name: string) {
    setCreating(false)
    const folderId = await createWorkspaceFolder(runId, name)
    setFolderOpen(folderId, true)
    rememberLastFolder(folderId)
    void navigate({ to: '/folders/$folderId', params: { folderId } })
  }

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
                onCommit={(name) => void createFolder(name)}
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
                pathname={pathname}
                now={now}
                onLinkRepo={() => setLinkFolderId(folder.folderId)}
              />
            )
          })}

          {unfiled.length > 0 ? (
            <div className="mt-4">
              <div className="flex h-7 items-center px-1.5">
                <SectionHeading>Unfiled</SectionHeading>
              </div>
              {unfiled.map((session) => (
                <SessionRow
                  key={session.runId}
                  runId={session.runId}
                  title={session.goal}
                  activity="idle"
                  status="unknown"
                  updatedAt={session.openedAt}
                  now={now}
                  active={pathname === `/sessions/${session.runId}`}
                />
              ))}
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

const SKELETON_WIDTHS = ['w-24', 'w-36', 'w-28', 'w-32', 'w-20']

function FolderTreeSkeleton({ error }: { error: string | null }) {
  return (
    <>
      <div className="flex h-7 shrink-0 items-center pr-2 pl-3">
        <SectionHeading>Folders</SectionHeading>
      </div>
      <div className="min-h-0 flex-1 px-3 pt-1" aria-busy={!error}>
        {error ? (
          <div className="rounded-lg border border-dashed px-3 py-3">
            <p className="text-status-failed text-[11.5px] leading-relaxed">{error}</p>
            <Button
              variant="secondary"
              size="xs"
              className="mt-2"
              onClick={() => window.location.reload()}
            >
              Retry
            </Button>
          </div>
        ) : (
          SKELETON_WIDTHS.map((width, index) => (
            <div
              key={width}
              className="flex h-8 items-center gap-2"
              style={{ opacity: 1 - index * 0.15 }}
            >
              <span className="bg-accent size-3.5 rounded-sm" />
              <span className={cn('bg-accent h-2.5 rounded-sm', width)} />
            </div>
          ))
        )}
      </div>
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
      <IconTip label="Add GitHub account">
        <Button variant="ghost" size="icon-xs" aria-label="Add GitHub account" asChild>
          <a href="/github/install">
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
  to: '/' | '/playbook'
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

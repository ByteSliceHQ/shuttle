import { Link, useNavigate, useRouterState } from '@tanstack/react-router'
import {
  BookOpen,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  MoreHorizontal,
  Orbit,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  SquarePen,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'

import { ActivityDot, SessionRowShell } from '@/components/sidebar/activity-dot'
import { LinkRepoDialog } from '@/components/sidebar/link-repo-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/cn'
import { recentSessions } from '@/lib/recent-sessions'
import { compactRelativeTime } from '@/lib/time'
import {
  archiveWorkspaceFolder,
  archiveWorkspaceSession,
  createWorkspaceFolder,
  fetchWorkspace,
  rememberLastFolder,
  renameWorkspaceFolder,
  renameWorkspaceSession,
  sessionsForFolder,
  workspaceTree,
  type WorkspaceTree,
} from '@/lib/workspace'
import { LoomsProvider, useProjection, useRunStore } from '@swirls/looms/react'

const COLLAPSED_KEY = 'shuttle.sidebar-collapsed'
const EXPANDED_KEY = 'shuttle.sidebar-expanded'
const SHOW_ARCHIVED_KEY = 'shuttle.sidebar-show-archived'
const SESSION_PREVIEW = 5

export function AppSidebarShell({ children }: { children: React.ReactNode }) {
  const [workspaceRunId, setWorkspaceRunId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void fetchWorkspace()
      .then((result) => setWorkspaceRunId(result.runId))
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : 'Failed to load workspace'),
      )
  }, [])

  return (
    <LoomsProvider endpoint="">
      <div className="flex h-dvh min-h-0">
        {workspaceRunId ? (
          <AppSidebar runId={workspaceRunId} />
        ) : (
          <aside className="bg-sidebar border-border flex w-[260px] shrink-0 flex-col border-r">
            <div className="text-muted-foreground flex h-12 items-center gap-2 px-3 text-xs">
              <Orbit className="size-3.5" />
              {error ?? 'Loading workspace…'}
            </div>
          </aside>
        )}
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </LoomsProvider>
  )
}

function AppSidebar({ runId }: { runId: string }) {
  const store = useRunStore(runId)
  const tree = useProjection(store, workspaceTree)
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (state) => state.location.pathname })

  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === '1')

  const [showArchived, setShowArchived] = useState(
    () => localStorage.getItem(SHOW_ARCHIVED_KEY) === '1',
  )

  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '{}') as Record<string, boolean>
    } catch {
      return {}
    }
  })

  const [creating, setCreating] = useState(false)
  const [draftName, setDraftName] = useState('New folder')
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null)
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null)
  const [linkFolderId, setLinkFolderId] = useState<string | null>(null)
  const [moreFolders, setMoreFolders] = useState<Record<string, boolean>>({})
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0')
  }, [collapsed])

  useEffect(() => {
    localStorage.setItem(SHOW_ARCHIVED_KEY, showArchived ? '1' : '0')
  }, [showArchived])

  useEffect(() => {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify(expanded))
  }, [expanded])

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault()
        setCollapsed((value) => !value)
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        void navigate({ to: '/' })
      }
    },
    [navigate],
  )

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onKeyDown])

  const folders = useMemo(
    () =>
      tree.folderOrder
        .map((id) => tree.folders[id])
        .filter((folder): folder is NonNullable<typeof folder> => Boolean(folder))
        .filter((folder) => showArchived || !folder.archived),
    [tree, showArchived],
  )

  const filedRunIds = useMemo(() => new Set(Object.keys(tree.sessions)), [tree.sessions])

  const unfiled = useMemo(
    () =>
      recentSessions()
        .filter((session) => !filedRunIds.has(session.runId))
        .slice(0, 8),
    [filedRunIds],
  )

  const installations = Object.values(tree.installations)
  const linkFolder = linkFolderId ? tree.folders[linkFolderId] : null

  async function submitNewFolder() {
    const name = draftName.trim() || 'New folder'
    setCreating(false)
    const folderId = await createWorkspaceFolder(runId, name)
    setExpanded((prev) => ({ ...prev, [folderId]: true }))
    rememberLastFolder(folderId)
    void navigate({ to: '/folders/$folderId', params: { folderId } })
  }

  if (collapsed) {
    return (
      <aside className="bg-sidebar border-border flex w-12 shrink-0 flex-col items-center gap-2 border-r py-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Expand sidebar"
          onClick={() => setCollapsed(false)}
        >
          <PanelLeftOpen />
        </Button>
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to="/" aria-label="New session">
            <SquarePen />
          </Link>
        </Button>
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to="/playbook" aria-label="Playbook">
            <BookOpen />
          </Link>
        </Button>
      </aside>
    )
  }

  return (
    <aside className="bg-sidebar border-border flex w-[260px] shrink-0 flex-col border-r">
      <div className="flex h-12 items-center gap-2 border-b px-2.5">
        <Link to="/" className="flex min-w-0 flex-1 items-center gap-2 px-0.5">
          <span className="bg-brand/15 text-brand ring-brand/25 flex size-6 items-center justify-center rounded-md ring-1 ring-inset">
            <Orbit className="size-3.5" />
          </span>
          <span className="truncate text-[13px] font-semibold tracking-tight">Shuttle</span>
        </Link>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Collapse sidebar"
          onClick={() => setCollapsed(true)}
        >
          <PanelLeftClose />
        </Button>
      </div>

      <div className="flex flex-col gap-0.5 p-2">
        <SidebarNavLink to="/" icon={<SquarePen className="size-3.5" />} active={pathname === '/'}>
          New Session
        </SidebarNavLink>
        <SidebarNavLink
          to="/playbook"
          icon={<BookOpen className="size-3.5" />}
          active={pathname === '/playbook'}
        >
          Playbook
        </SidebarNavLink>
      </div>

      <div className="flex items-center gap-1 px-3 pt-2 pb-1">
        <span className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
          Folders
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          className="ml-auto"
          title={showArchived ? 'Hide archived' : 'Show archived'}
          onClick={() => setShowArchived((value) => !value)}
        >
          <Badge variant="outline" className="h-4 px-1 text-[9px]">
            {showArchived ? 'All' : 'Active'}
          </Badge>
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="New folder"
          onClick={() => {
            setDraftName('New folder')
            setCreating(true)
          }}
        >
          <FolderPlus />
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1 px-1.5 pb-2">
        {creating ? (
          <div className="px-1.5 py-1">
            <Input
              autoFocus
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              onBlur={() => void submitNewFolder()}
              onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void submitNewFolder()
                }

                if (event.key === 'Escape') {
                  setCreating(false)
                }
              }}
              className="h-7 text-xs"
            />
          </div>
        ) : null}

        {folders.length === 0 && !creating ? (
          <p className="text-muted-foreground px-3 py-4 text-[11px] leading-relaxed">
            Create a folder to organize sessions and link GitHub repos.
          </p>
        ) : null}

        {folders.map((folder) => {
          const open = expanded[folder.folderId] ?? true

          const sessions = sessionsForFolder(tree, folder.folderId, {
            includeArchived: showArchived,
          })

          const visible = moreFolders[folder.folderId]
            ? sessions
            : sessions.slice(0, SESSION_PREVIEW)

          const folderActive = pathname === `/folders/${folder.folderId}`

          return (
            <div key={folder.folderId} className="mb-1">
              <div
                className={cn(
                  'group flex h-8 items-center gap-1 rounded-md px-1.5 transition-colors',
                  folderActive ? 'bg-accent' : 'hover:bg-accent/40',
                )}
              >
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground flex size-5 items-center justify-center"
                  onClick={() =>
                    setExpanded((prev) => ({
                      ...prev,
                      [folder.folderId]: !open,
                    }))
                  }
                  aria-label={open ? 'Collapse folder' : 'Expand folder'}
                >
                  <ChevronRight
                    className={cn('size-3.5 transition-transform', open && 'rotate-90')}
                  />
                </button>
                {renamingFolderId === folder.folderId ? (
                  <Input
                    autoFocus
                    defaultValue={folder.name}
                    className="h-6 flex-1 text-xs"
                    onBlur={(event) => {
                      const name = event.target.value.trim()
                      setRenamingFolderId(null)

                      if (name && name !== folder.name) {
                        void renameWorkspaceFolder(runId, folder.folderId, name)
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.currentTarget.blur()
                      }

                      if (event.key === 'Escape') {
                        setRenamingFolderId(null)
                      }
                    }}
                  />
                ) : (
                  <Link
                    to="/folders/$folderId"
                    params={{ folderId: folder.folderId }}
                    className="flex min-w-0 flex-1 items-center gap-1.5"
                    onDoubleClick={(event) => {
                      event.preventDefault()
                      setRenamingFolderId(folder.folderId)
                    }}
                    onClick={() => rememberLastFolder(folder.folderId)}
                  >
                    {open ? (
                      <FolderOpen className="text-muted-foreground size-3.5 shrink-0" />
                    ) : (
                      <Folder className="text-muted-foreground size-3.5 shrink-0" />
                    )}
                    <span className="truncate text-[12.5px] font-medium">{folder.name}</span>
                    {folder.repos.length > 0 ? (
                      <span className="text-muted-foreground font-mono text-[10px] tabular-nums">
                        {folder.repos.length}
                      </span>
                    ) : null}
                  </Link>
                )}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="opacity-0 group-hover:opacity-100"
                  aria-label="New session in folder"
                  onClick={() => {
                    rememberLastFolder(folder.folderId)

                    void navigate({
                      to: '/folders/$folderId',
                      params: { folderId: folder.folderId },
                    })
                  }}
                >
                  <Plus />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="opacity-0 group-hover:opacity-100"
                      aria-label="Folder menu"
                    >
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem onSelect={() => setRenamingFolderId(folder.folderId)}>
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setLinkFolderId(folder.folderId)}>
                      Link repository
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => void archiveWorkspaceFolder(runId, folder.folderId)}
                    >
                      Archive
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              {open ? (
                <div className="ml-3 border-l border-white/5 pl-1">
                  {visible.map((session) => {
                    const active = pathname === `/sessions/${session.runId}`

                    if (renamingSessionId === session.runId) {
                      return (
                        <div key={session.runId} className="px-1 py-0.5">
                          <Input
                            autoFocus
                            defaultValue={session.title}
                            className="h-6 text-xs"
                            onBlur={(event) => {
                              const title = event.target.value.trim()
                              setRenamingSessionId(null)

                              if (title && title !== session.title) {
                                void renameWorkspaceSession(runId, session.runId, title)
                              }
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.currentTarget.blur()
                              }

                              if (event.key === 'Escape') {
                                setRenamingSessionId(null)
                              }
                            }}
                          />
                        </div>
                      )
                    }

                    return (
                      <Link
                        key={session.runId}
                        to="/sessions/$sessionId"
                        params={{ sessionId: session.runId }}
                        className="block"
                      >
                        <SessionRowShell active={active}>
                          <ActivityDot activity={session.activity} status={session.status} />
                          <span className="min-w-0 flex-1 truncate">{session.title}</span>
                          <span className="text-muted-foreground font-mono text-[10px] tabular-nums">
                            {compactRelativeTime(session.updatedAt, now)}
                          </span>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button
                                type="button"
                                className="hover:text-foreground opacity-0 group-hover:opacity-100"
                                onClick={(event) => event.preventDefault()}
                                aria-label="Session menu"
                              >
                                <MoreHorizontal className="size-3.5" />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                              <DropdownMenuItem
                                onSelect={() => setRenamingSessionId(session.runId)}
                              >
                                Rename
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={() => void archiveWorkspaceSession(runId, session.runId)}
                              >
                                Archive
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </SessionRowShell>
                      </Link>
                    )
                  })}
                  {sessions.length > SESSION_PREVIEW && !moreFolders[folder.folderId] ? (
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground px-2 py-1 text-[11px]"
                      onClick={() =>
                        setMoreFolders((prev) => ({ ...prev, [folder.folderId]: true }))
                      }
                    >
                      More
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          )
        })}

        {unfiled.length > 0 ? (
          <div className="mt-3">
            <div className="text-muted-foreground px-2 pb-1 text-[11px] font-medium tracking-wide uppercase">
              Unfiled
            </div>
            {unfiled.map((session) => (
              <Link
                key={session.runId}
                to="/sessions/$sessionId"
                params={{ sessionId: session.runId }}
                className="block"
              >
                <SessionRowShell active={pathname === `/sessions/${session.runId}`}>
                  <ActivityDot activity="idle" status="running" />
                  <span className="min-w-0 flex-1 truncate">{session.goal}</span>
                  <span className="text-muted-foreground font-mono text-[10px] tabular-nums">
                    {compactRelativeTime(session.openedAt, now)}
                  </span>
                </SessionRowShell>
              </Link>
            ))}
          </div>
        ) : null}
      </ScrollArea>

      <div className="border-border flex items-center gap-2 border-t px-3 py-2.5">
        {installations.length > 0 ? (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <div className="flex -space-x-1.5">
              {installations.slice(0, 3).map((installation) =>
                installation.account.avatarUrl ? (
                  <img
                    key={installation.installationId}
                    src={installation.account.avatarUrl}
                    alt={installation.account.login}
                    className="border-sidebar size-5 rounded-full border"
                  />
                ) : (
                  <span
                    key={installation.installationId}
                    className="bg-accent flex size-5 items-center justify-center rounded-full text-[9px]"
                  >
                    {installation.account.login.slice(0, 1).toUpperCase()}
                  </span>
                ),
              )}
            </div>
            <span className="text-muted-foreground truncate text-[11px]">
              {installations.map((installation) => installation.account.login).join(', ')}
            </span>
          </div>
        ) : (
          <Button variant="ghost" size="sm" className="w-full justify-start" asChild>
            <a href="/github/install">
              <GitBranch />
              Connect GitHub
            </a>
          </Button>
        )}
      </div>

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
    </aside>
  )
}

function SidebarNavLink({
  to,
  icon,
  active,
  children,
}: {
  to: '/' | '/playbook'
  icon: React.ReactNode
  active: boolean
  children: React.ReactNode
}) {
  return (
    <Link
      to={to}
      className={cn(
        'flex h-8 items-center gap-2 rounded-md px-2 text-[12.5px] transition-colors',
        active
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
      )}
    >
      {icon}
      {children}
    </Link>
  )
}

/** Expose tree for pages that need folder context without a second subscription. */
export type { WorkspaceTree }

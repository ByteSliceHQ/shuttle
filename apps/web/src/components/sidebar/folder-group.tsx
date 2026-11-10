import { Link } from '@tanstack/react-router'
import {
  Archive,
  ChevronRight,
  Folder,
  FolderOpen,
  GitBranch,
  MoreHorizontal,
  Plus,
} from 'lucide-react'
import { useState } from 'react'

import { InlineNameInput } from '@/components/sidebar/inline-name-input'
import {
  revealOnRowHover,
  SessionRow,
  sidebarRowClass,
  yieldOnRowHover,
} from '@/components/sidebar/session-row'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/cn'
import {
  archiveWorkspaceFolder,
  archiveWorkspaceSession,
  rememberLastFolder,
  renameWorkspaceFolder,
  renameWorkspaceSession,
  repoCountLabel,
  type WorkspaceFolder,
  type WorkspaceSession,
} from '@/lib/workspace'

const SESSION_PREVIEW = 5

export function FolderGroup({
  runId,
  folder,
  sessions,
  open,
  onToggle,
  pathname,
  now,
  onLinkRepo,
}: {
  runId: string
  folder: WorkspaceFolder
  sessions: readonly WorkspaceSession[]
  open: boolean
  onToggle: () => void
  pathname: string
  now: number
  onLinkRepo: () => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)

  const visible = showAll ? sessions : sessions.slice(0, SESSION_PREVIEW)
  const hidden = sessions.length - visible.length
  const folderActive = pathname === `/folders/${folder.folderId}`
  const FolderIcon = folder.archived ? Archive : open ? FolderOpen : Folder
  const repoCount = folder.repos.length

  return (
    <div className="mb-0.5">
      <div className={cn(sidebarRowClass(folderActive), folder.archived && 'opacity-60')}>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${folder.name}`}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 ml-0.5 flex size-6 shrink-0 items-center justify-center rounded-sm outline-none focus-visible:ring-2"
        >
          <ChevronRight
            className={cn(
              'ease-snappy size-3.5 transition-transform duration-150',
              open && 'rotate-90',
            )}
          />
        </button>

        {renaming ? (
          <div className="min-w-0 flex-1 pr-1">
            <InlineNameInput
              initialValue={folder.name}
              label="Folder name"
              onCancel={() => setRenaming(false)}
              onCommit={(name) => {
                setRenaming(false)
                void renameWorkspaceFolder(runId, folder.folderId, name)
              }}
            />
          </div>
        ) : (
          <>
            <Link
              to="/folders/$folderId"
              params={{ folderId: folder.folderId }}
              title={folder.name}
              onClick={() => rememberLastFolder(folder.folderId)}
              onDoubleClick={(event) => {
                event.preventDefault()
                setRenaming(true)
              }}
              className="focus-visible:ring-ring/50 flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md pr-1 outline-none focus-visible:ring-2"
            >
              <FolderIcon className="text-muted-foreground size-3.5 shrink-0" />
              <span className="text-foreground/90 min-w-0 truncate font-medium" dir="auto">
                {folder.name}
              </span>
            </Link>

            <div className="relative mr-1 flex h-6 w-[3.25rem] shrink-0 items-center justify-end">
              {repoCount > 0 ? (
                <span
                  title={repoCountLabel(repoCount)}
                  aria-label={repoCountLabel(repoCount)}
                  className={cn(
                    'text-muted-foreground inline-flex items-center gap-0.5 font-mono text-[10px] tabular-nums',
                    yieldOnRowHover,
                  )}
                >
                  <GitBranch className="size-2.5" />
                  {repoCount}
                </span>
              ) : null}
              <div className={cn('absolute inset-y-0 right-0 flex items-center', revealOnRowHover)}>
                {folder.archived ? null : (
                  <Link
                    to="/folders/$folderId"
                    params={{ folderId: folder.folderId }}
                    aria-label={`New session in ${folder.name}`}
                    title="New session"
                    onClick={() => rememberLastFolder(folder.folderId)}
                    className="text-muted-foreground hover:text-foreground hover:bg-accent flex size-6 items-center justify-center rounded-sm"
                  >
                    <Plus className="size-3.5" />
                  </Link>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={`Actions for ${folder.name}`}
                      className="text-muted-foreground hover:text-foreground hover:bg-accent data-[state=open]:bg-accent flex size-6 items-center justify-center rounded-sm outline-none"
                    >
                      <MoreHorizontal className="size-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="min-w-40">
                    <DropdownMenuItem onSelect={() => setRenaming(true)}>Rename</DropdownMenuItem>
                    {folder.archived ? null : (
                      <>
                        <DropdownMenuItem onSelect={onLinkRepo}>Link repository…</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onSelect={() => void archiveWorkspaceFolder(runId, folder.folderId)}
                        >
                          Archive
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </>
        )}
      </div>

      {open ? (
        <div className="ml-[1.125rem] border-l border-white/5 pl-1">
          {visible.map((session) =>
            renamingSessionId === session.runId ? (
              <div key={session.runId} className="py-0.5 pr-1">
                <InlineNameInput
                  initialValue={session.title}
                  label="Session title"
                  onCancel={() => setRenamingSessionId(null)}
                  onCommit={(title) => {
                    setRenamingSessionId(null)
                    void renameWorkspaceSession(runId, session.runId, title)
                  }}
                />
              </div>
            ) : (
              <SessionRow
                key={session.runId}
                runId={session.runId}
                title={session.title}
                activity={session.activity}
                status={session.status}
                updatedAt={session.updatedAt}
                now={now}
                active={pathname === `/sessions/${session.runId}`}
                dimmed={session.archived}
                onRename={() => setRenamingSessionId(session.runId)}
                onArchive={
                  session.archived
                    ? undefined
                    : () => void archiveWorkspaceSession(runId, session.runId)
                }
              />
            ),
          )}

          {sessions.length === 0 && !folder.archived ? (
            <Link
              to="/folders/$folderId"
              params={{ folderId: folder.folderId }}
              onClick={() => rememberLastFolder(folder.folderId)}
              className="text-muted-foreground/70 hover:text-foreground flex h-7 items-center gap-2 rounded-md px-2 text-[11.5px] transition-colors duration-100"
            >
              <Plus className="size-3" />
              Start a session
            </Link>
          ) : null}

          {sessions.length > SESSION_PREVIEW ? (
            <button
              type="button"
              onClick={() => setShowAll((value) => !value)}
              className="text-muted-foreground hover:text-foreground flex h-7 items-center rounded-md px-2 text-[11px] transition-colors duration-100"
            >
              {showAll ? 'Show less' : `Show ${hidden} more`}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

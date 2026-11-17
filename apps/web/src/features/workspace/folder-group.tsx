import { useMutation } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  Archive,
  ChevronRight,
  Folder,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  MoreHorizontal,
  Plus,
} from 'lucide-react'
import { useState } from 'react'

import { api } from '@/api/client'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { setPullInboxCollapsed } from '@/features/pulls/pull-inbox-pref'
import { isSessionUnread, type SeenSessionsSnapshot } from '@/features/sessions/seen-sessions'
import {
  resolveFolderIndicator,
  resolveSessionIndicator,
} from '@/features/sessions/session-activity'
import { cn } from '@/lib/cn'

import { ActivityDot } from './activity-dot'
import { InlineNameInput } from './inline-name-input'
import { revealOnRowHover, SessionRow, sidebarRowClass, yieldOnRowHover } from './session-row'
import {
  archiveWorkspaceFolder,
  rememberLastFolder,
  renameWorkspaceFolder,
  repoCountLabel,
  type WorkspaceFolder,
  type WorkspaceSession,
} from './workspace'

const SESSION_PREVIEW = 5

export function FolderGroup({
  runId,
  folder,
  sessions,
  open,
  onToggle,
  pathname,
  activeRunId,
  seenSnapshot,
  now,
  pullAttention = 0,
  pullCounts,
  onLinkRepo,
}: {
  runId: string
  folder: WorkspaceFolder
  sessions: readonly WorkspaceSession[]
  open: boolean
  onToggle: () => void
  pathname: string
  activeRunId: string | null
  seenSnapshot: SeenSessionsSnapshot
  now: number
  pullAttention?: number
  /** Open PRs per session run id. */
  pullCounts: ReadonlyMap<string, number>
  onLinkRepo: () => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)

  // Nothing waits on these: the sidebar shows the new name, or the row gone, when the
  // workspace's own events say so.
  const renameFolder = useMutation({
    mutationFn: (name: string) => renameWorkspaceFolder(runId, folder.folderId, name),
  })

  const archiveFolder = useMutation({
    mutationFn: () => archiveWorkspaceFolder(runId, folder.folderId),
  })

  const renameSession = useMutation(api.sessions.rename.mutationOptions())
  const archiveSession = useMutation(api.sessions.archive.mutationOptions())

  const visible = showAll ? sessions : sessions.slice(0, SESSION_PREVIEW)
  const hidden = sessions.length - visible.length
  const folderActive = pathname === `/folders/${folder.folderId}`
  const FolderIcon = folder.archived ? Archive : open ? FolderOpen : Folder
  const repoCount = folder.repos.length

  const activeFolderSessions = folder.archived
    ? []
    : sessions.filter((session) => !session.archived)

  const collapsedRollup = !open
    ? resolveFolderIndicator(
        activeFolderSessions.map((session) =>
          resolveSessionIndicator({
            activity: session.activity,
            status: session.status,
            unread: isSessionUnread(session, { activeRunId, snapshot: seenSnapshot }),
          }),
        ),
      )
    : null

  const hiddenRollup =
    open && !showAll && hidden > 0
      ? resolveFolderIndicator(
          sessions
            .slice(SESSION_PREVIEW)
            .filter((session) => !session.archived)
            .map((session) =>
              resolveSessionIndicator({
                activity: session.activity,
                status: session.status,
                unread: isSessionUnread(session, { activeRunId, snapshot: seenSnapshot }),
              }),
            ),
        )
      : null

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
                renameFolder.mutate(name)
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

            <div className="relative mr-1 flex h-6 w-20 shrink-0 items-center justify-end">
              <div className={cn('inline-flex items-center gap-1.5', yieldOnRowHover)}>
                {collapsedRollup ? (
                  <ActivityDot tone={collapsedRollup.tone} label={collapsedRollup.label} />
                ) : null}
                <FolderMeta
                  folderId={folder.folderId}
                  repoCount={repoCount}
                  pullAttention={pullAttention}
                />
              </div>
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
                        <DropdownMenuItem onSelect={() => archiveFolder.mutate()}>
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
          {visible.map((session) => {
            const unread = isSessionUnread(session, { activeRunId, snapshot: seenSnapshot })

            return renamingSessionId === session.runId ? (
              <div key={session.runId} className="py-0.5 pr-1">
                <InlineNameInput
                  initialValue={session.title}
                  label="Session title"
                  onCancel={() => setRenamingSessionId(null)}
                  onCommit={(title) => {
                    setRenamingSessionId(null)
                    renameSession.mutate({ id: session.runId, title })
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
                unread={unread}
                updatedAt={session.updatedAt}
                now={now}
                active={activeRunId === session.runId}
                dimmed={session.archived}
                pullCount={pullCounts.get(session.runId)}
                onRename={() => setRenamingSessionId(session.runId)}
                onArchive={
                  session.archived ? undefined : () => archiveSession.mutate({ id: session.runId })
                }
              />
            )
          })}

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
              className="text-muted-foreground hover:text-foreground flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[11px] transition-colors duration-100"
            >
              {hiddenRollup ? (
                <ActivityDot tone={hiddenRollup.tone} label={hiddenRollup.label} />
              ) : null}
              {showAll ? 'Show less' : `Show ${hidden} more`}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function compactCount(count: number): string {
  return count > 99 ? '99+' : String(count)
}

function FolderMeta({
  folderId,
  repoCount,
  pullAttention,
}: {
  folderId: string
  repoCount: number
  pullAttention: number
}) {
  if (repoCount === 0) {
    return null
  }

  const pullLabel = `${pullAttention} pull request${pullAttention === 1 ? '' : 's'} need attention`

  return (
    <span className="inline-flex items-center gap-1 font-mono text-[10px] tabular-nums">
      <span
        title={repoCountLabel(repoCount)}
        aria-label={repoCountLabel(repoCount)}
        className="bg-muted text-muted-foreground inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5"
      >
        <GitBranch className="size-2.5" />
        {compactCount(repoCount)}
      </span>
      {pullAttention > 0 ? (
        <Link
          to="/folders/$folderId"
          params={{ folderId }}
          title={pullLabel}
          aria-label={pullLabel}
          onClick={() => {
            rememberLastFolder(folderId)
            setPullInboxCollapsed(false)
          }}
          className="bg-brand/15 text-brand hover:bg-brand/25 inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 transition-colors duration-100"
        >
          <GitPullRequest className="size-2.5" />
          {compactCount(pullAttention)}
        </Link>
      ) : null}
    </span>
  )
}

import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { ArrowRight, Link2, LoaderCircle, Plus } from 'lucide-react'
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'

import { NotFound } from '@/components/not-found'
import { ActivityDot } from '@/components/sidebar/activity-dot'
import { LinkRepoDialog } from '@/components/sidebar/link-repo-dialog'
import { RepoChip } from '@/components/sidebar/repo-chip'
import { useWorkspace, WorkspacePending } from '@/components/sidebar/workspace-context'
import { Button } from '@/components/ui/button'
import { EmptyState, Kbd } from '@/components/ui/panel'
import { Textarea } from '@/components/ui/textarea'
import { errorMessage } from '@/lib/cn'
import { rememberSession } from '@/lib/recent-sessions'
import { isSessionUnread, useSeenSessions } from '@/lib/seen-sessions'
import { resolveSessionIndicator, sessionIndicatorLabel } from '@/lib/session-activity'
import { compactRelativeTime, fullDateTime } from '@/lib/time'
import { useNow } from '@/lib/use-now'
import {
  rememberLastFolder,
  sessionsForFolder,
  startWorkspaceSession,
  unlinkFolderRepo,
  type WorkspaceFolder,
  type WorkspaceTree,
} from '@/lib/workspace'

export const Route = createFileRoute('/folders/$folderId')({
  component: FolderPage,
})

const DEMO_GOAL = 'Add a zod schema for greet() and cover it with a small test.'
const REPO_PREVIEW = 8

function FolderPage() {
  const { folderId } = Route.useParams()
  const workspace = useWorkspace()

  useEffect(() => {
    rememberLastFolder(folderId)
  }, [folderId])

  if (!workspace) {
    return <WorkspacePending label="Loading folder…" />
  }

  const folder = workspace.tree.folders[folderId]

  if (!folder) {
    return (
      <NotFound eyebrow="Folder not found" title="This folder came unravelled">
        Nothing in your workspace answers to that link. Pick a folder from the sidebar, or head home
        and start something new.
      </NotFound>
    )
  }

  return <FolderWorkspace key={folderId} tree={workspace.tree} folder={folder} />
}

function FolderWorkspace({ tree, folder }: { tree: WorkspaceTree; folder: WorkspaceFolder }) {
  const navigate = useNavigate()
  const now = useNow()
  const seenSnapshot = useSeenSessions()
  const [goal, setGoal] = useState(() => (folder.repos.length === 0 ? DEMO_GOAL : ''))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [linkOpen, setLinkOpen] = useState(false)
  const [showAllRepos, setShowAllRepos] = useState(false)

  const sessions = useMemo(() => sessionsForFolder(tree, folder.folderId), [tree, folder])
  const repos = showAllRepos ? folder.repos : folder.repos.slice(0, REPO_PREVIEW)
  const hiddenRepos = folder.repos.length - repos.length

  function start() {
    const trimmed = goal.trim()

    if (!trimmed || busy) {
      return
    }

    setBusy(true)
    setError(null)

    void startWorkspaceSession({ folderId: folder.folderId, goal: trimmed })
      .then(({ runId: sessionId }) => {
        rememberSession({ runId: sessionId, goal: trimmed })
        return navigate({ to: '/sessions/$sessionId', params: { sessionId } })
      })
      .catch((cause: unknown) => setError(errorMessage(cause)))
      .finally(() => setBusy(false))
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      start()
    }
  }

  function unlink(fullName: string) {
    setError(null)

    void unlinkFolderRepo(folder.folderId, fullName).catch((cause: unknown) =>
      setError(errorMessage(cause)),
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="stagger mx-auto flex w-full max-w-2xl flex-col gap-10 px-6 pt-16 pb-24">
        <section>
          <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
            Folder
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-balance wrap-anywhere">
            What should the agents build in{' '}
            <span dir="auto" className="text-brand">
              {folder.name}
            </span>
            ?
          </h1>

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {repos.map((repo) => (
              <RepoChip
                key={repo.fullName}
                repo={repo}
                onRemove={folder.archived ? undefined : () => unlink(repo.fullName)}
              />
            ))}
            {hiddenRepos > 0 ? (
              <Button variant="ghost" size="xs" onClick={() => setShowAllRepos(true)}>
                +{hiddenRepos} more
              </Button>
            ) : null}
            {folder.archived ? null : (
              <Button variant="ghost" size="xs" onClick={() => setLinkOpen(true)}>
                <Link2 />
                {folder.repos.length === 0 ? 'Link a repository' : 'Link another'}
              </Button>
            )}
          </div>
          {folder.repos.length === 0 ? (
            <p className="text-muted-foreground mt-2 text-xs">
              No repos linked yet, so agents work in the demo workspace.
            </p>
          ) : null}

          <div className="bg-card mt-6 rounded-xl border p-1.5 shadow-xl shadow-black/20">
            <Textarea
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              onKeyDown={onKeyDown}
              aria-label="Session goal"
              placeholder="Describe the change you want…"
              className="max-h-80 min-h-24 resize-none border-0 bg-transparent text-sm focus-visible:ring-0"
            />
            <div className="flex items-center gap-2 px-1.5 pb-0.5">
              <span className="text-muted-foreground ml-auto hidden items-center gap-1 text-[11px] sm:inline-flex">
                <Kbd>⌘</Kbd>
                <Kbd>↵</Kbd>
              </span>
              <Button variant="brand" onClick={start} disabled={busy || !goal.trim()}>
                {busy ? <LoaderCircle className="animate-spin" /> : <ArrowRight />}
                {busy ? 'Starting' : 'Start session'}
              </Button>
            </div>
          </div>
          {error ? <p className="text-status-failed mt-3 text-xs wrap-anywhere">{error}</p> : null}
        </section>

        <section>
          <div className="mb-2 flex items-baseline gap-2">
            <h2 className="text-[13px] font-medium">Sessions</h2>
            {sessions.length > 0 ? (
              <span className="text-muted-foreground font-mono text-[11px] tabular-nums">
                {sessions.length.toLocaleString()}
              </span>
            ) : null}
          </div>
          {sessions.length === 0 ? (
            <div className="rounded-xl border border-dashed">
              <EmptyState icon={<Plus />} title="No sessions yet">
                Describe a change above and agents will pick it up in this folder.
              </EmptyState>
            </div>
          ) : (
            <ul className="bg-card/40 divide-y overflow-hidden rounded-xl border">
              {sessions.map((session) => {
                const unread = isSessionUnread(session, { snapshot: seenSnapshot })

                const tone = resolveSessionIndicator({
                  activity: session.activity,
                  status: session.status,
                  unread,
                })

                return (
                  <li key={session.runId}>
                    <Link
                      to="/sessions/$sessionId"
                      params={{ sessionId: session.runId }}
                      className="hover:bg-accent/40 group flex items-center gap-3 px-4 py-3 transition-colors duration-100"
                    >
                      <ActivityDot tone={tone} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px]" dir="auto" title={session.title}>
                          {session.title}
                        </p>
                        <p className="text-muted-foreground mt-0.5 text-[11px]">
                          <time title={fullDateTime(session.updatedAt)}>
                            {compactRelativeTime(session.updatedAt, now)}
                          </time>
                          {' · '}
                          {sessionIndicatorLabel(tone)}
                        </p>
                      </div>
                      <ArrowRight className="text-muted-foreground size-3.5 shrink-0 -translate-x-1 opacity-0 transition-[opacity,translate] duration-150 group-hover:translate-x-0 group-hover:opacity-100" />
                    </Link>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>

      <LinkRepoDialog
        open={linkOpen}
        onOpenChange={setLinkOpen}
        folderId={folder.folderId}
        folderName={folder.name}
        tree={tree}
        linked={folder.repos}
      />
    </div>
  )
}

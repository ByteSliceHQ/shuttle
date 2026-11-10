import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { ArrowRight, GitBranch, Link2, LoaderCircle, Lock, Plus } from 'lucide-react'
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'

import { ActivityDot } from '@/components/sidebar/activity-dot'
import { LinkRepoDialog } from '@/components/sidebar/link-repo-dialog'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/panel'
import { Textarea } from '@/components/ui/textarea'
import { cn, errorMessage } from '@/lib/cn'
import { rememberSession } from '@/lib/recent-sessions'
import { compactRelativeTime } from '@/lib/time'
import {
  fetchWorkspace,
  lastFolderId,
  rememberLastFolder,
  sessionsForFolder,
  startWorkspaceSession,
  workspaceTree,
  type WorkspaceTree,
} from '@/lib/workspace'
import { useProjection, useRunStore } from '@swirls/looms/react'

export const Route = createFileRoute('/folders/$folderId')({
  component: FolderPage,
})

const DEFAULT_GOAL = 'Add a zod schema for greet() and cover it with a small test.'

function FolderPage() {
  const { folderId } = Route.useParams()
  const [workspaceRunId, setWorkspaceRunId] = useState<string | null>(null)

  useEffect(() => {
    rememberLastFolder(folderId)
    void fetchWorkspace().then((result) => setWorkspaceRunId(result.runId))
  }, [folderId])

  if (!workspaceRunId) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
        Loading folder…
      </div>
    )
  }

  return <FolderWorkspace runId={workspaceRunId} folderId={folderId} />
}

function FolderWorkspace({ runId, folderId }: { runId: string; folderId: string }) {
  const store = useRunStore(runId)
  const tree = useProjection(store, workspaceTree)
  const folder = tree.folders[folderId]
  const navigate = useNavigate()
  const [goal, setGoal] = useState(DEFAULT_GOAL)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [linkOpen, setLinkOpen] = useState(false)
  const [now] = useState(() => Date.now())

  const sessions = useMemo(
    () => (folder ? sessionsForFolder(tree, folder.folderId) : []),
    [tree, folder],
  )

  function start() {
    const trimmed = goal.trim()

    if (!trimmed || busy || !folder) {
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

  if (!folder) {
    return (
      <div className="mx-auto flex h-full max-w-lg flex-col items-center justify-center gap-3 px-6">
        <EmptyState icon={<GitBranch />} title="Folder not found">
          It may have been archived. Pick another folder from the sidebar.
        </EmptyState>
        <Button variant="outline" size="sm" asChild>
          <Link to="/">Back home</Link>
        </Button>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="stagger mx-auto flex w-full max-w-2xl flex-col gap-10 px-6 pt-16 pb-24">
        <section>
          <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
            Folder
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-balance">
            What should the agents build in {folder.name}?
          </h1>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {folder.repos.map((repo) => (
              <RepoChip key={repo.fullName} repo={repo} />
            ))}
            <Button variant="ghost" size="sm" onClick={() => setLinkOpen(true)}>
              <Link2 />
              {folder.repos.length === 0 ? 'Link a repository' : 'Link another'}
            </Button>
          </div>

          <div className="bg-card mt-6 rounded-xl border p-1.5 shadow-xl shadow-black/20">
            <Textarea
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              onKeyDown={onKeyDown}
              aria-label="Session goal"
              placeholder="Describe the change you want…"
              className="min-h-24 resize-none border-0 bg-transparent text-sm focus-visible:ring-0"
            />
            <div className="flex items-center gap-2 px-1.5 pb-0.5">
              <span className="text-muted-foreground ml-auto hidden text-[11px] sm:inline">
                ⌘↵ to start
              </span>
              <Button variant="brand" onClick={start} disabled={busy || !goal.trim()}>
                {busy ? <LoaderCircle className="animate-spin" /> : <ArrowRight />}
                {busy ? 'Starting' : 'Start session'}
              </Button>
            </div>
          </div>
          {error ? <p className="text-status-failed mt-3 text-xs">{error}</p> : null}
        </section>

        <section>
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-[13px] font-medium">Sessions</h2>
            <span className="text-muted-foreground font-mono text-[11px] tabular-nums">
              {sessions.length || ''}
            </span>
          </div>
          {sessions.length === 0 ? (
            <div className="rounded-xl border border-dashed">
              <EmptyState icon={<Plus />} title="No sessions yet">
                {folder.repos.length === 0
                  ? 'Link a repository, then start a session above.'
                  : 'Start a session above to put agents to work.'}
              </EmptyState>
            </div>
          ) : (
            <ul className="bg-card/40 divide-y overflow-hidden rounded-xl border">
              {sessions.map((session) => (
                <li key={session.runId}>
                  <Link
                    to="/sessions/$sessionId"
                    params={{ sessionId: session.runId }}
                    className="hover:bg-accent/40 group flex items-center gap-3 px-4 py-3 transition-colors duration-150"
                  >
                    <ActivityDot activity={session.activity} status={session.status} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px]">{session.title}</p>
                      <p className="text-muted-foreground mt-0.5 text-[11px]">
                        {compactRelativeTime(session.updatedAt, now)} · {session.status}
                      </p>
                    </div>
                    <ArrowRight className="text-muted-foreground size-3.5 -translate-x-1 opacity-0 transition-[opacity,translate] duration-150 group-hover:translate-x-0 group-hover:opacity-100" />
                  </Link>
                </li>
              ))}
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

export function RepoChip({
  repo,
}: {
  repo: { fullName: string; private: boolean; defaultBranch: string }
}) {
  return (
    <span className="bg-card/60 text-muted-foreground inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-[11px]">
      <GitBranch className="size-3" />
      <span className="text-foreground max-w-40 truncate">{repo.fullName}</span>
      {repo.private ? <Lock className="size-3" /> : null}
      <span className="font-mono text-[10px]">{repo.defaultBranch}</span>
    </span>
  )
}

/** Prefer last-used folder when present in the tree. */
export function preferredFolderId(tree: WorkspaceTree): string | null {
  const remembered = lastFolderId()

  if (remembered && tree.folders[remembered] && !tree.folders[remembered]?.archived) {
    return remembered
  }

  return (
    tree.folderOrder.find((id) => {
      const folder = tree.folders[id]
      return folder && !folder.archived
    }) ?? null
  )
}

export function folderClassName(active: boolean) {
  return cn(active ? 'bg-accent' : 'hover:bg-accent/40')
}

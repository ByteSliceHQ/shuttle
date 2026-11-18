import { useMutation } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { ArrowRight, Link2, LoaderCircle, Plus } from 'lucide-react'
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'

import { api } from '@/api/client'
import { NotFound } from '@/components/not-found'
import { host } from '@/host'
import {
  ActivityDot,
  HarnessSwitcher,
  isSessionUnread,
  LinkRepoDialog,
  PullInboxPanel,
  PullInboxSheetButton,
  rememberLastFolder,
  rememberSession,
  RepoChip,
  resolveSessionIndicator,
  sessionIndicatorLabel,
  sessionsForFolder,
  SignInGate,
  StartAttachments,
  startWorkspaceSession,
  useAgentGate,
  useDefaultHarness,
  usePullInbox,
  useSeenSessions,
  useStartAttachments,
  useStartPlace,
  useWorkspace,
  type WorkspaceFolder,
  type WorkspaceTree,
} from '@shuttle/react'
import {
  Button,
  compactRelativeTime,
  EmptyState,
  fullDateTime,
  Kbd,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useMediaQuery,
  useNow,
} from '@shuttle/react/ui'

export const Route = createFileRoute('/_app/folders/$folderId')({
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

  const folder = workspace.tree.folders[folderId]

  // Checked here and not in a loader. The loader can only see the snapshot the app opened with,
  // and a folder made since then, like one just created from the sidebar, which goes straight
  // to this page, is only in the tree the event stream keeps.
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
  const attachments = useStartAttachments()
  const [linkOpen, setLinkOpen] = useState(false)
  const agent = useDefaultHarness()
  const startPlace = useStartPlace()
  const gate = useAgentGate(agent.harness, startPlace)
  const [showAllRepos, setShowAllRepos] = useState(false)

  const sessions = useMemo(() => sessionsForFolder(tree, folder.folderId), [tree, folder])
  const repos = showAllRepos ? folder.repos : folder.repos.slice(0, REPO_PREVIEW)
  const hiddenRepos = folder.repos.length - repos.length
  const hasRepos = folder.repos.length > 0
  const wide = useMediaQuery('(min-width: 1024px)')
  const repoNames = useMemo(() => folder.repos.map((repo) => repo.fullName), [folder.repos])
  const pullInbox = usePullInbox(folder.folderId, repoNames)

  const startSession = useMutation({
    async mutationFn(trimmed: string) {
      await agent.save()

      return startWorkspaceSession(host, {
        folderId: folder.folderId,
        goal: trimmed,
        files: attachments.files,
      })
    },
    onSuccess({ runId: sessionId }, trimmed) {
      rememberSession({ runId: sessionId, goal: trimmed })
      return navigate({ to: '/sessions/$sessionId', params: { sessionId } })
    },
  })

  // The chip goes when the workspace's events say the repository is unlinked.
  const unlinkRepo = useMutation(api.workspace.repos.unlink.mutationOptions())
  const busy = startSession.isPending
  // One line under the composer reports whichever of the two was tried last.
  const error = startSession.error ?? unlinkRepo.error

  function start() {
    const trimmed = goal.trim()

    if (!trimmed || busy || gate.blocked) {
      return
    }

    unlinkRepo.reset()
    startSession.mutate(trimmed)
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      start()
    }
  }

  function unlink(fullName: string) {
    startSession.reset()
    unlinkRepo.mutate({ folderId: folder.folderId, fullName })
  }

  return (
    <div className="flex h-full">
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="stagger mx-auto flex w-full max-w-2xl flex-col gap-10 px-6 pt-16 pb-24">
          <section>
            <div className="flex h-6 items-center justify-between gap-2">
              <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
                Folder
              </p>
              {hasRepos && !wide ? <PullInboxSheetButton data={pullInbox} /> : null}
            </div>
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
              {folder.archived ? null : hasRepos ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Link another repository"
                      onClick={() => setLinkOpen(true)}
                      className="rounded-full"
                    >
                      <Plus />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Link another repository</TooltipContent>
                </Tooltip>
              ) : (
                <Button variant="ghost" size="xs" onClick={() => setLinkOpen(true)}>
                  <Link2 />
                  Link a repository
                </Button>
              )}
            </div>
            {hasRepos ? null : (
              <p className="text-muted-foreground mt-2 text-xs">
                No repos linked yet, so agents work in the demo workspace.
              </p>
            )}

            <div className="bg-card mt-6 rounded-xl border p-1.5 shadow-xl shadow-black/20">
              {gate.blocked && gate.connection ? (
                <SignInGate
                  connection={gate.connection}
                  place={startPlace}
                  onSignedIn={gate.reload}
                  upcoming
                />
              ) : null}
              <StartAttachments files={attachments.files} remove={attachments.remove} />
              <Textarea
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                onKeyDown={onKeyDown}
                onPaste={attachments.onPaste}
                disabled={busy}
                aria-label="Session goal"
                placeholder="Describe the change you want…"
                className="max-h-80 min-h-24 resize-none border-0 bg-transparent text-sm focus-visible:ring-0"
              />
              <div className="flex items-center gap-2 px-1.5 pb-0.5">
                <HarnessSwitcher
                  value={agent.harness}
                  onChange={agent.setHarness}
                  team={agent.team}
                  onTeamChange={agent.setTeam}
                  disabled={busy}
                  side="bottom"
                  place={startPlace}
                />
                <span className="text-muted-foreground ml-auto hidden items-center gap-1 text-[11px] sm:inline-flex">
                  <Kbd>⌘</Kbd>
                  <Kbd>↵</Kbd>
                </span>
                <Button
                  variant="brand"
                  onClick={start}
                  disabled={busy || !goal.trim() || gate.blocked}
                >
                  {busy ? <LoaderCircle className="animate-spin" /> : <ArrowRight />}
                  {busy ? 'Starting' : 'Start session'}
                </Button>
              </div>
            </div>
            {attachments.error ? (
              <p role="alert" className="text-status-failed mt-3 text-xs">
                {attachments.error}
              </p>
            ) : null}
            {error ? (
              <p className="text-status-failed mt-3 text-xs wrap-anywhere">{error.message}</p>
            ) : null}
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
      </div>

      {hasRepos && wide ? <PullInboxPanel data={pullInbox} /> : null}

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

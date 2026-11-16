import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import {
  ArrowRight,
  BookOpen,
  Folder,
  LoaderCircle,
  MessageSquareMore,
  Network,
} from 'lucide-react'
import { useMemo, useState, type KeyboardEvent } from 'react'

import { HarnessSwitcher, useDefaultHarness } from '@/components/harness-switcher'
import { useWorkspace, WorkspacePending } from '@/components/sidebar/workspace-context'
import { SignInGate, useAgentGate, useStartPlace } from '@/components/sign-in'
import { Button } from '@/components/ui/button'
import { EmptyState, Kbd } from '@/components/ui/panel'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { errorMessage } from '@/lib/cn'
import { rememberSession } from '@/lib/recent-sessions'
import {
  createWorkspaceFolder,
  orderedFolders,
  preferredFolderId,
  rememberLastFolder,
  repoCountLabel,
  startWorkspaceSession,
  type WorkspaceTree,
} from '@/lib/workspace'

export const Route = createFileRoute('/')({
  component: HomePage,
})

const DEFAULT_GOAL = 'Add a zod schema for greet() and cover it with a small test.'
const FOLDER_PREVIEW = 6

function HomePage() {
  const workspace = useWorkspace()

  if (!workspace) {
    return <WorkspacePending label="Loading workspace…" />
  }

  return <HomeComposer runId={workspace.runId} tree={workspace.tree} />
}

function HomeComposer({ runId, tree }: { runId: string; tree: WorkspaceTree }) {
  const navigate = useNavigate()

  const folders = useMemo(() => orderedFolders(tree), [tree])

  const [goal, setGoal] = useState(DEFAULT_GOAL)
  const [folderId, setFolderId] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const agent = useDefaultHarness()
  const startPlace = useStartPlace()
  const gate = useAgentGate(agent.harness, startPlace)
  const selectedFolderId = folderId || preferredFolderId(tree) || ''

  async function ensureFolder(): Promise<string> {
    if (selectedFolderId) {
      return selectedFolderId
    }

    const created = await createWorkspaceFolder(runId, 'General')
    setFolderId(created)
    return created
  }

  function start() {
    const trimmed = goal.trim()

    if (!trimmed || busy || gate.blocked) {
      return
    }

    setBusy(true)
    setError(null)

    void agent
      .save()
      .then(ensureFolder)
      .then((resolvedFolderId) => {
        rememberLastFolder(resolvedFolderId)
        return startWorkspaceSession({ folderId: resolvedFolderId, goal: trimmed })
      })
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

  return (
    <div className="h-full overflow-y-auto">
      <div className="stagger mx-auto flex w-full max-w-2xl flex-col gap-10 px-6 pt-16 pb-24">
        <section>
          <h1 className="text-2xl font-semibold tracking-tight text-balance">
            What should the agents build?
          </h1>
          <p className="text-muted-foreground mt-2 max-w-xl text-sm leading-relaxed text-pretty">
            Sessions live inside folders. Link GitHub repos to a folder and every agent spawned
            there gets worktrees of those repos.
          </p>

          <div className="bg-card mt-6 rounded-xl border p-1.5 shadow-xl shadow-black/20">
            {gate.blocked && gate.connection ? (
              <SignInGate
                connection={gate.connection}
                place={startPlace}
                onSignedIn={gate.reload}
                upcoming
              />
            ) : null}
            <Textarea
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              onKeyDown={onKeyDown}
              aria-label="Session goal"
              placeholder="Describe the change you want…"
              className="min-h-24 resize-none border-0 bg-transparent text-sm focus-visible:ring-0"
            />
            <div className="flex flex-wrap items-center gap-2 px-1.5 pb-0.5">
              {folders.length > 0 ? (
                <Select
                  value={selectedFolderId || undefined}
                  onValueChange={(value) => setFolderId(value)}
                >
                  <SelectTrigger
                    className="h-7 w-auto max-w-56 min-w-36 gap-1.5 text-xs [&>span]:truncate"
                    aria-label="Folder"
                  >
                    <Folder className="text-muted-foreground size-3.5 shrink-0" />
                    <SelectValue placeholder="Folder" />
                  </SelectTrigger>
                  <SelectContent className="max-w-80">
                    {folders.map((folder) => (
                      <SelectItem key={folder.folderId} value={folder.folderId}>
                        <span className="truncate" dir="auto">
                          {folder.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <span className="text-muted-foreground inline-flex items-center gap-1.5 text-[11px]">
                  <Folder className="size-3.5" />
                  Creates a General folder
                </span>
              )}
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
          {error ? <p className="text-status-failed mt-3 text-xs">{error}</p> : null}
        </section>

        <section className="grid gap-3 sm:grid-cols-3">
          <Feature icon={<MessageSquareMore />} title="Interject anytime">
            Intake classifies each message as a question, idea, constraint, correction, task, or
            stop.
          </Feature>
          <Feature icon={<Network />} title="Agents in a tree">
            A conductor delegates to workers in a Cloudflare Sandbox. Every thread is inspectable.
          </Feature>
          <Feature icon={<BookOpen />} title="Learns from history">
            The reflect module mines the event log and proposes playbook lessons for approval.
          </Feature>
        </section>

        {folders.length === 0 ? (
          <div className="rounded-xl border border-dashed">
            <EmptyState icon={<Folder />} title="No folders yet">
              Start a session above, or create a folder from the sidebar.
            </EmptyState>
          </div>
        ) : (
          <section>
            <div className="mb-2 flex items-baseline gap-2">
              <h2 className="text-[13px] font-medium">Folders</h2>
              <span className="text-muted-foreground font-mono text-[11px] tabular-nums">
                {folders.length.toLocaleString()}
              </span>
            </div>
            <ul className="bg-card/40 divide-y overflow-hidden rounded-xl border">
              {folders.slice(0, FOLDER_PREVIEW).map((folder) => (
                <li key={folder.folderId}>
                  <Link
                    to="/folders/$folderId"
                    params={{ folderId: folder.folderId }}
                    className="hover:bg-accent/40 group flex items-center gap-3 px-4 py-3 transition-colors duration-100"
                  >
                    <Folder className="text-muted-foreground size-3.5 shrink-0" />
                    <span
                      className="min-w-0 flex-1 truncate text-[13px]"
                      dir="auto"
                      title={folder.name}
                    >
                      {folder.name}
                    </span>
                    <span className="text-muted-foreground shrink-0 text-[11px]">
                      {folder.repos.length === 0
                        ? 'Demo repo'
                        : repoCountLabel(folder.repos.length)}
                    </span>
                    <ArrowRight className="text-muted-foreground size-3.5 shrink-0 transition-transform duration-150 group-hover:translate-x-0.5" />
                  </Link>
                </li>
              ))}
            </ul>
            {folders.length > FOLDER_PREVIEW ? (
              <p className="text-muted-foreground mt-2 text-[11px]">
                {(folders.length - FOLDER_PREVIEW).toLocaleString()} more in the sidebar.
              </p>
            ) : null}
          </section>
        )}
      </div>
    </div>
  )
}

function Feature({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="bg-card/40 rounded-xl border p-4">
      <div className="text-brand mb-3 [&_svg]:size-4">{icon}</div>
      <h3 className="text-[13px] font-medium">{title}</h3>
      <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{children}</p>
    </div>
  )
}

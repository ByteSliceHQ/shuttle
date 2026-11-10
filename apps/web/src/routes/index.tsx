import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import {
  ArrowRight,
  BookOpen,
  GitBranch,
  LoaderCircle,
  MessageSquareMore,
  Network,
  SquareStack,
} from 'lucide-react'
import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmptyState, Kbd } from '@/components/ui/panel'
import { Textarea } from '@/components/ui/textarea'
import { fetchSessions, startSession, type IndexedSession } from '@/lib/api'
import { errorMessage, shortId } from '@/lib/cn'
import { recentSessions, rememberSession } from '@/lib/recent-sessions'
import { relativeTime, runCreatedAt } from '@/lib/time'

export const Route = createFileRoute('/')({
  component: HomePage,
})

const DEFAULT_GOAL = 'Add a zod schema for greet() and cover it with a small test.'

interface SessionRow {
  readonly runId: string
  readonly goal?: string
  readonly status?: string
  readonly at?: number
}

function HomePage() {
  const navigate = useNavigate()
  const [goal, setGoal] = useState(DEFAULT_GOAL)
  const [repoUrl, setRepoUrl] = useState('')
  const [showRepo, setShowRepo] = useState(false)
  const [indexed, setIndexed] = useState<readonly IndexedSession[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [now] = useState(() => Date.now())

  useEffect(() => {
    void fetchSessions()
      .then((result) => setIndexed(result.sessions))
      .catch(() => setIndexed([]))
  }, [])

  const sessions = useMemo<readonly SessionRow[]>(() => {
    const local = recentSessions()

    const byId = new Map<string, SessionRow>(
      local.map((entry) => [
        entry.runId,
        { runId: entry.runId, goal: entry.goal, at: entry.openedAt },
      ]),
    )

    for (const entry of indexed) {
      const existing = byId.get(entry.runId)

      byId.set(entry.runId, {
        runId: entry.runId,
        goal: existing?.goal,
        status: entry.status,
        at: existing?.at ?? runCreatedAt(entry.runId),
      })
    }

    return [...byId.values()].toSorted((left, right) => (right.at ?? 0) - (left.at ?? 0))
  }, [indexed])

  function start() {
    const trimmed = goal.trim()

    if (!trimmed || busy) {
      return
    }

    setBusy(true)
    setError(null)

    void startSession({ goal: trimmed, repoUrl: repoUrl.trim() || null })
      .then(({ runId }) => {
        rememberSession({ runId, goal: trimmed })
        return navigate({ to: '/sessions/$sessionId', params: { sessionId: runId } })
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
            Every session is a durable Looms run on your Cloudflare account. Interrupt it with
            questions, ideas, and corrections at any time; a root session routes each one without
            derailing the work.
          </p>

          <div className="bg-card mt-6 rounded-xl border p-1.5 shadow-xl shadow-black/20">
            <Textarea
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              onKeyDown={onKeyDown}
              aria-label="Session goal"
              placeholder="Describe the change you want…"
              className="min-h-24 resize-none border-0 bg-transparent text-sm focus-visible:ring-0"
            />
            {showRepo ? (
              <div className="px-1.5 pb-1.5">
                <Input
                  autoFocus
                  value={repoUrl}
                  onChange={(event) => setRepoUrl(event.target.value)}
                  placeholder="https://github.com/org/repo"
                  aria-label="Repository URL"
                  className="font-mono text-xs"
                />
              </div>
            ) : null}
            <div className="flex items-center gap-2 px-1.5 pb-0.5">
              <Button variant="ghost" size="sm" onClick={() => setShowRepo(!showRepo)}>
                <GitBranch />
                {showRepo ? 'Use the demo workspace' : 'Use a repository'}
              </Button>
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

        <section>
          <div className="mb-2 flex items-center gap-2">
            <SquareStack className="text-muted-foreground size-3.5" />
            <h2 className="text-[13px] font-medium">Recent sessions</h2>
            <span className="text-muted-foreground font-mono text-[11px] tabular-nums">
              {sessions.length || ''}
            </span>
          </div>
          {sessions.length === 0 ? (
            <div className="rounded-xl border border-dashed">
              <EmptyState icon={<SquareStack />} title="No sessions yet">
                Start one above. Bind a D1 replica to list sessions across browsers.
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
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px]">{session.goal ?? 'Coding session'}</p>
                      <p className="text-muted-foreground mt-0.5 flex items-center gap-2 text-[11px]">
                        <span className="font-mono">{shortId(session.runId)}</span>
                        {session.at ? <span>{relativeTime(session.at, now)}</span> : null}
                        {session.status ? <span>{session.status}</span> : null}
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
    </div>
  )
}

function Feature({
  icon,
  title,
  children,
}: {
  icon: ReactNode
  title: string
  children: ReactNode
}) {
  return (
    <div className="bg-card/40 rounded-xl border p-4">
      <div className="text-brand mb-3 [&_svg]:size-4">{icon}</div>
      <h3 className="text-[13px] font-medium">{title}</h3>
      <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{children}</p>
    </div>
  )
}

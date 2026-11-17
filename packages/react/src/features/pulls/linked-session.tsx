import { ArrowRight } from 'lucide-react'
import type { ReactNode } from 'react'

import { cn } from '../../lib/cn'
import { Link } from '../../shuttle'
import { useWorkspace } from '../workspace/workspace-context'
import type { LinkedSession } from './pulls'

export function useSessionTitle(runId: string | undefined): string | undefined {
  const sessions = useWorkspace().tree.sessions
  return runId ? sessions[runId]?.title : undefined
}

/** Opens the session focused on the agent thread that acted on the PR. */
export function LinkedSessionLink({
  session,
  className,
  children,
}: {
  session: LinkedSession
  className?: string
  children: ReactNode
}) {
  return (
    <Link
      to={{ page: 'session', sessionId: session.runId, thread: session.threadId }}
      className={cn('group inline-flex min-w-0 items-center gap-1', className)}
    >
      {children}
      <ArrowRight className="size-3 shrink-0 transition-transform duration-150 group-hover:translate-x-0.5" />
    </Link>
  )
}

export function LinkedSessionRow({ session }: { session: LinkedSession }) {
  const title = useSessionTitle(session.runId)
  const known = useWorkspace().tree.sessions[session.runId]

  // Skip stale/corrupt links (e.g. a thread id recorded as the run id).
  if (!known && !title) {
    return null
  }

  return (
    <LinkedSessionLink session={session} className="text-brand hover:underline">
      <span className="shrink-0">{session.role === 'author' ? 'Opened in' : 'Reviewed in'}</span>
      <span className="text-foreground/90 min-w-0 truncate" dir="auto" title={title}>
        {title ?? 'a session'}
      </span>
    </LinkedSessionLink>
  )
}

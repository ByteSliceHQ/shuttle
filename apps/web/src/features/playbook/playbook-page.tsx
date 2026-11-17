import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { BookOpen, Check, Inbox, LoaderCircle, RefreshCw, Sparkles, X } from 'lucide-react'
import type { ReactNode } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/panel'
import { decideApproval } from '@/features/sessions/signals'
import { cn, shortId } from '@/lib/cn'
import { Link, useShuttleHost } from '@/shuttle'
import type { PlaybookLesson } from '@shuttle/api'

import { playbookQuery } from './playbook-query'

type Decision = 'approve' | 'reject'

/** The playbook page. Its route's loader has read the playbook before this renders. */
export function PlaybookPage() {
  const host = useShuttleHost()

  const {
    data: { runId, playbook },
    error,
    isFetching,
    refetch,
  } = useSuspenseQuery(playbookQuery(host))

  const proposed = Object.entries(playbook.proposed ?? {})
  const lessons = playbook.lessons

  return (
    <div className="h-full overflow-y-auto">
      <div className="stagger mx-auto flex w-full max-w-2xl flex-col gap-10 px-6 pt-16 pb-24">
        <section className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5">
              <h1 className="text-2xl font-semibold tracking-tight">Playbook</h1>
              <Badge variant="outline">v{playbook.version}</Badge>
            </div>
            <p className="text-muted-foreground mt-2 max-w-xl text-sm leading-relaxed text-pretty">
              When a session goes idle, the custom <code className="text-foreground">reflect</code>{' '}
              module reads its event history, finds friction, and proposes lessons. Approved lessons
              load into the conductor and workers of the next session.
            </p>
            <p className="text-muted-foreground mt-2 font-mono text-[11px]">{runId}</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
            <RefreshCw className={cn(isFetching && 'animate-spin')} />
            Refresh
          </Button>
        </section>

        {/* A refresh that fails leaves the playbook as last read on screen, with the reason. */}
        {error ? <p className="text-status-failed -mt-6 text-xs">{error.message}</p> : null}

        <Section
          icon={<Inbox />}
          title="Awaiting review"
          count={proposed.length}
          empty={
            <EmptyState icon={<Sparkles />} title="Nothing to review">
              Finish a session with a correction or a stop and the reflector will propose a lesson.
            </EmptyState>
          }
        >
          {proposed.map(([lessonId, lesson]) => (
            <ProposedLesson key={lessonId} runId={runId} lessonId={lessonId} lesson={lesson} />
          ))}
        </Section>

        <Section
          icon={<BookOpen />}
          title="Active lessons"
          count={lessons.length}
          empty={
            <EmptyState icon={<BookOpen />} title="No approved lessons yet">
              Approved lessons appear here and ship with every new session.
            </EmptyState>
          }
        >
          {lessons.map((lesson) => (
            <LessonCard key={lesson.id} lesson={lesson} />
          ))}
        </Section>
      </div>
    </div>
  )
}

/** A lesson waiting for review, with the buttons that approve or reject it. */
function ProposedLesson({
  runId,
  lessonId,
  lesson,
}: {
  /** The playbook's run, which takes the decision. */
  runId: string
  lessonId: string
  lesson: Omit<PlaybookLesson, 'id'>
}) {
  const host = useShuttleHost()
  const queryClient = useQueryClient()

  const decide = useMutation({
    mutationFn: (decision: Decision) => decideApproval(host, runId, `lesson_${lessonId}`, decision),
    // The buttons stay busy until the playbook has been read again and the lesson has moved.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: playbookQuery(host).queryKey }),
  })

  const deciding = decide.isPending ? decide.variables : undefined

  return (
    <LessonCard
      lesson={lesson}
      pending
      error={decide.error?.message}
      actions={
        <>
          <Button
            variant="success"
            size="sm"
            disabled={deciding !== undefined}
            onClick={() => decide.mutate('approve')}
          >
            {deciding === 'approve' ? <LoaderCircle className="animate-spin" /> : <Check />}
            Approve
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={deciding !== undefined}
            onClick={() => decide.mutate('reject')}
          >
            {deciding === 'reject' ? <LoaderCircle className="animate-spin" /> : <X />}
            Reject
          </Button>
        </>
      }
    />
  )
}

function Section({
  icon,
  title,
  count,
  empty,
  children,
}: {
  icon: ReactNode
  title: string
  count: number
  empty: ReactNode
  children: ReactNode
}) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-muted-foreground [&_svg]:size-3.5">{icon}</span>
        <h2 className="text-[13px] font-medium">{title}</h2>
        <span className="text-muted-foreground font-mono text-[11px] tabular-nums">
          {count || ''}
        </span>
      </div>
      {count === 0 ? (
        <div className="rounded-xl border border-dashed">{empty}</div>
      ) : (
        <ul className="flex flex-col gap-2">{children}</ul>
      )}
    </section>
  )
}

function LessonCard({
  lesson,
  pending = false,
  actions,
  error,
}: {
  lesson: Omit<PlaybookLesson, 'id'>
  pending?: boolean
  /** Buttons that sit at the end of the card's last row. */
  actions?: ReactNode
  /** Why the last decision on this lesson did not go through. */
  error?: string
}) {
  return (
    <li
      className={cn(
        'bg-card/50 rounded-xl border p-4',
        pending && 'border-route-idea/25 bg-route-idea/[0.04]',
      )}
    >
      <p className="text-[13.5px] leading-relaxed">{lesson.text}</p>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {lesson.scope ? <Badge variant="outline">{lesson.scope}</Badge> : null}
        {lesson.evidence.map((item) => (
          <Link
            key={`${item.runId}_${item.seq}`}
            to={{ page: 'session', sessionId: item.runId }}
            className="text-muted-foreground hover:text-foreground hover:bg-accent inline-flex h-5 items-center rounded-full border px-2 font-mono text-[10px] transition-colors duration-150"
            title={`${item.runId} · event #${item.seq}`}
          >
            {shortId(item.runId)}#{item.seq}
          </Link>
        ))}
        {actions ? <div className="ml-auto flex gap-1.5">{actions}</div> : null}
      </div>
      {error ? <p className="text-status-failed mt-2 text-xs">{error}</p> : null}
    </li>
  )
}

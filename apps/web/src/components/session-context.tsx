import { Link } from '@tanstack/react-router'
import { ArrowRight, BookOpen, FileText, LoaderCircle } from 'lucide-react'
import { useState } from 'react'

import { Markdown } from '@/components/markdown'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/panel'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { fetchPlaybook, type PlaybookLesson } from '@/lib/api'
import { cn, errorMessage, shortId } from '@/lib/cn'
import {
  currentBrief,
  type BriefRevision,
  type PlaybookLessonRef,
  type SessionFeed,
} from '@/lib/session-feed'
import { fullDateTime, relativeTime } from '@/lib/time'
import { useNow } from '@/lib/use-now'

type ContextTab = 'brief' | 'playbook'

type LivePlaybook =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; lessons: ReadonlyMap<string, PlaybookLesson> }
  | { state: 'failed'; error: string }

const QUOTE_MAX = 140

function isContextTab(value: string): value is ContextTab {
  return value === 'brief' || value === 'playbook'
}

function lessonCountLabel(count: number): string {
  return count === 1 ? '1 lesson' : `${count} lessons`
}

function quote(text: string): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim())
  return chars.length > QUOTE_MAX ? `${chars.slice(0, QUOTE_MAX - 1).join('')}…` : chars.join('')
}

/**
 * The brief the agents are working from, as one chip under the composer. Its sheet also holds
 * the playbook lessons the session started with. The version shows only once it was amended.
 */
export function SessionContextButtons({ feed }: { feed: SessionFeed }) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<ContextTab>('brief')
  const [live, setLive] = useState<LivePlaybook>({ state: 'idle' })
  const brief = currentBrief(feed)
  const lessons = feed.playbook.lessons

  function loadLive() {
    if (live.state === 'loading' || live.state === 'ready') {
      return
    }

    setLive({ state: 'loading' })

    void fetchPlaybook()
      .then(({ playbook }) =>
        setLive({
          state: 'ready',
          lessons: new Map(playbook.lessons.map((lesson) => [lesson.id, lesson])),
        }),
      )
      .catch((cause: unknown) => setLive({ state: 'failed', error: errorMessage(cause) }))
  }

  function show(next: ContextTab) {
    setTab(next)
    setOpen(true)

    if (next === 'playbook' && lessons.length > 0) {
      loadLive()
    }
  }

  if (!brief) {
    return null
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => show('brief')}
        title="Brief"
        aria-label={
          lessons.length > 0
            ? `Brief, with ${lessonCountLabel(lessons.length)} from the playbook`
            : 'Brief'
        }
      >
        <FileText />
        {/* Icon only where the composer is narrow, so the row under it stays on one line. */}
        <span className="hidden @md:inline">Brief</span>
        {feed.brief.length > 1 ? (
          <span className="text-route-idea font-mono text-[10px] tabular-nums">
            v{brief.version}
          </span>
        ) : null}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent>
          <Tabs
            value={tab}
            onValueChange={(value) => {
              if (isContextTab(value)) {
                show(value)
              }
            }}
            className="min-h-0 flex-1 gap-0"
          >
            <div className="border-b px-5 pt-5 pb-4">
              <SheetTitle className="pr-8">Session context</SheetTitle>
              <SheetDescription className="mt-1 pr-8">
                What the conductor and its workers were told to work from.
              </SheetDescription>
              <TabsList className="mt-4">
                <TabsTrigger value="brief">
                  <FileText />
                  Brief
                </TabsTrigger>
                <TabsTrigger value="playbook">
                  <BookOpen />
                  Playbook
                  <span className="text-muted-foreground font-mono text-[10px] tabular-nums">
                    {lessons.length}
                  </span>
                </TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="brief" className="overflow-y-auto overscroll-contain">
              <BriefHistory current={brief} feed={feed} />
            </TabsContent>
            <TabsContent value="playbook" className="overflow-y-auto overscroll-contain">
              <PlaybookLessons
                version={feed.playbook.version}
                lessons={lessons}
                live={live}
                onRetry={loadLive}
              />
            </TabsContent>
          </Tabs>
        </SheetContent>
      </Sheet>
    </>
  )
}

function BriefHistory({ current, feed }: { current: BriefRevision; feed: SessionFeed }) {
  const now = useNow()

  const earlier = feed.brief
    .filter((revision) => revision.version !== current.version)
    .toSorted((left, right) => right.version - left.version)

  const trigger = current.sourceMessageId ? feed.messageText[current.sourceMessageId] : undefined

  return (
    <div className="flex flex-col gap-6 p-5">
      <section>
        <RevisionMeta
          revision={current}
          label={earlier.length > 0 ? 'Current' : 'Original goal'}
          now={now}
          emphasis
        />
        <p
          dir="auto"
          className="bg-card mt-2 rounded-xl border p-4 text-[13px] leading-relaxed wrap-anywhere whitespace-pre-wrap"
        >
          {current.text}
        </p>
        {trigger ? (
          <p className="text-muted-foreground mt-2 text-xs leading-relaxed wrap-anywhere">
            Amended after you said <span className="text-foreground/80">“{quote(trigger)}”</span>
          </p>
        ) : null}
      </section>
      {earlier.length > 0 ? (
        <section>
          <h3 className="text-muted-foreground mb-3 text-[11px] font-medium">Earlier versions</h3>
          <ol className="ml-1 flex flex-col gap-4 border-l pl-4">
            {earlier.map((revision) => (
              <li key={revision.version}>
                <RevisionMeta
                  revision={revision}
                  label={revision.version === 1 ? 'Original goal' : 'Amended'}
                  now={now}
                />
                <p
                  dir="auto"
                  className="text-muted-foreground mt-1 line-clamp-4 text-xs leading-relaxed wrap-anywhere whitespace-pre-wrap"
                  title={revision.text}
                >
                  {revision.text}
                </p>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  )
}

function RevisionMeta({
  revision,
  label,
  now,
  emphasis = false,
}: {
  revision: BriefRevision
  label: string
  now: number
  emphasis?: boolean
}) {
  return (
    <div className="flex items-center gap-1.5 text-[11px]">
      <span className={cn('font-medium', emphasis ? 'text-foreground' : 'text-muted-foreground')}>
        {label}
      </span>
      <span className="text-muted-foreground font-mono tabular-nums">v{revision.version}</span>
      <span className="text-muted-foreground/60">·</span>
      <time
        className="text-muted-foreground"
        dateTime={new Date(revision.ts).toISOString()}
        title={fullDateTime(revision.ts)}
      >
        {relativeTime(revision.ts, now)}
      </time>
    </div>
  )
}

function PlaybookLessons({
  version,
  lessons,
  live,
  onRetry,
}: {
  version: number
  lessons: readonly PlaybookLessonRef[]
  live: LivePlaybook
  onRetry: () => void
}) {
  if (lessons.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 p-5">
        <EmptyState icon={<BookOpen />} title="No lessons loaded" className="h-auto">
          This session started from an empty playbook. When sessions go idle, the reflector proposes
          lessons, and approved ones ship with the next session.
        </EmptyState>
        <OpenPlaybookLink />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 p-5">
      <div className="text-muted-foreground flex items-center gap-2 text-xs">
        <span>
          {lessonCountLabel(lessons.length)} from playbook{' '}
          <span className="font-mono tabular-nums">v{version}</span>, loaded when this session
          started.
        </span>
        {live.state === 'loading' ? (
          <LoaderCircle aria-label="Loading lesson details" className="size-3 animate-spin" />
        ) : null}
      </div>
      {live.state === 'failed' ? (
        <p className="text-status-failed text-xs">
          Couldn’t load lesson details. {live.error}{' '}
          <button type="button" className="underline underline-offset-2" onClick={onRetry}>
            Retry
          </button>
        </p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {lessons.map((lesson) => (
          <LessonCard
            key={lesson.id}
            lesson={lesson}
            detail={live.state === 'ready' ? (live.lessons.get(lesson.id) ?? null) : undefined}
          />
        ))}
      </ul>
      <OpenPlaybookLink />
    </div>
  )
}

function LessonCard({
  lesson,
  detail,
}: {
  lesson: PlaybookLessonRef
  /** `null` once the live playbook loads without this lesson, i.e. it was retired since. */
  detail: PlaybookLesson | null | undefined
}) {
  const scope = lesson.scope ?? detail?.scope
  const retired = detail === null
  const sources = evidenceByRun(detail?.evidence ?? [])

  return (
    <li className="bg-card/60 rounded-xl border p-3.5">
      <Markdown text={lesson.text} className="text-[13px] leading-relaxed wrap-anywhere" />
      {scope || retired || sources.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {scope ? <Badge variant="outline">{scope}</Badge> : null}
          {retired ? (
            <Badge
              variant="outline"
              className="text-status-waiting"
              title="No longer in the active playbook"
            >
              Retired since
            </Badge>
          ) : null}
          {sources.length > 0 ? (
            <span className="text-muted-foreground ml-auto flex flex-wrap items-center justify-end gap-1.5 text-[11px]">
              Learned from
              {sources.map(({ runId, seqs }) => (
                <Link
                  key={runId}
                  to="/sessions/$sessionId"
                  params={{ sessionId: runId }}
                  className="hover:text-foreground hover:bg-accent inline-flex h-5 items-center gap-1 rounded-full border px-2 transition-colors duration-100"
                  title={`${runId}\nEvents ${seqs.map((seq) => `#${seq}`).join(', ')}`}
                >
                  <span className="font-mono text-[10px]">{shortId(runId)}</span>
                  {seqs.length > 1 ? (
                    <span className="text-muted-foreground/70 text-[10px] tabular-nums">
                      ×{seqs.length}
                    </span>
                  ) : null}
                </Link>
              ))}
            </span>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

function evidenceByRun(evidence: PlaybookLesson['evidence']): { runId: string; seqs: number[] }[] {
  const byRun = new Map<string, number[]>()

  for (const item of evidence) {
    byRun.set(item.runId, [...(byRun.get(item.runId) ?? []), item.seq])
  }

  return [...byRun].map(([runId, seqs]) => ({ runId, seqs: seqs.toSorted((a, b) => a - b) }))
}

function OpenPlaybookLink() {
  return (
    <Button variant="ghost" size="sm" className="self-start" asChild>
      <Link to="/playbook">
        Open playbook
        <ArrowRight />
      </Link>
    </Button>
  )
}

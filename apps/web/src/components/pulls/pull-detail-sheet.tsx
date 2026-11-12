import { Link, useNavigate } from '@tanstack/react-router'
import { ExternalLink, GitPullRequest, LoaderCircle, MessageSquareReply } from 'lucide-react'
import { useState } from 'react'

import { Markdown } from '@/components/markdown'
import { LinkedSessionRow } from '@/components/pulls/linked-session'
import {
  checkLabel,
  CheckGlyph,
  DiffCells,
  DiffStat,
  RepoDot,
  repoShortName,
  reviewLabel,
} from '@/components/pulls/pull-glyphs'
import { StackLadder } from '@/components/pulls/stack-ladder'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { errorMessage } from '@/lib/cn'
import { pullKey, startPullReview, type PullInboxSummary, type PullStack } from '@/lib/pulls'
import { compactRelativeTime, fullDateTime } from '@/lib/time'
import { useNow } from '@/lib/use-now'

type ReviewIntent = 'review' | 'feedback'

export function PullDetailSheet({
  folderId,
  pull,
  siblings,
  stack,
  onOpenPull,
  onOpenChange,
}: {
  folderId: string
  pull: PullInboxSummary | null
  /** Other open PRs the same session opened. */
  siblings: readonly PullInboxSummary[]
  stack: PullStack | null
  onOpenPull: (key: string) => void
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Sheet open={pull !== null} onOpenChange={onOpenChange}>
      <SheetContent>
        {pull ? (
          <PullDetail
            key={pullKey(pull.fullName, pull.number)}
            folderId={folderId}
            pull={pull}
            siblings={siblings}
            stack={stack}
            onOpenPull={onOpenPull}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function PullDetail({
  folderId,
  pull,
  siblings,
  stack,
  onOpenPull,
}: {
  folderId: string
  pull: PullInboxSummary
  siblings: readonly PullInboxSummary[]
  stack: PullStack | null
  onOpenPull: (key: string) => void
}) {
  const navigate = useNavigate()
  const now = useNow()
  const [pending, setPending] = useState<ReviewIntent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const review = reviewLabel(pull.reviewDecision)
  const body = pull.body.trim()

  function start(intent: ReviewIntent) {
    setPending(intent)
    setError(null)

    const title =
      intent === 'review'
        ? `Review ${pull.fullName}#${pull.number}`
        : `Address feedback on ${pull.fullName}#${pull.number}`

    void startPullReview(folderId, pull.fullName, pull.number, {
      headSha: pull.headSha,
      baseSha: pull.baseSha,
      title,
    })
      .then((result) =>
        navigate({ to: '/sessions/$sessionId', params: { sessionId: result.runId } }),
      )
      .catch((cause: unknown) => setError(errorMessage(cause)))
      .finally(() => setPending(null))
  }

  return (
    <>
      <header className="border-b px-5 pt-5 pr-12 pb-4">
        <p className="text-muted-foreground flex items-center gap-1.5 font-mono text-[11px]">
          <RepoDot fullName={pull.fullName} />
          {pull.fullName}
          <span className="text-muted-foreground/60">#{pull.number}</span>
          {pull.draft ? (
            <span className="bg-muted ml-1 rounded-sm px-1 font-sans text-[10px]">Draft</span>
          ) : null}
        </p>
        <SheetTitle className="mt-1.5 text-balance wrap-anywhere" dir="auto">
          {pull.title}
        </SheetTitle>
        <SheetDescription className="mt-1.5">
          <span className="text-foreground/80">{pull.author.login}</span> wants to merge{' '}
          <code className="font-mono text-[11px]">{pull.headRef}</code> into{' '}
          <code className="font-mono text-[11px]">{pull.baseRef}</code> ·{' '}
          <time title={fullDateTime(pull.updatedAt)}>
            {compactRelativeTime(pull.updatedAt, now)}
          </time>
        </SheetDescription>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-2.5 text-xs">
          <dt className="text-muted-foreground">Checks</dt>
          <dd className="flex items-center gap-1.5">
            <CheckGlyph rollup={pull.checkRollup} />
            {checkLabel(pull.checkRollup)}
          </dd>
          <dt className="text-muted-foreground">Review</dt>
          <dd className={review ? undefined : 'text-muted-foreground'}>
            {review ?? 'No reviews yet'}
          </dd>
          <dt className="text-muted-foreground">Changes</dt>
          <dd className="flex items-center gap-2">
            <DiffStat
              additions={pull.additions}
              deletions={pull.deletions}
              className="text-[11px]"
            />
            <DiffCells additions={pull.additions} deletions={pull.deletions} />
          </dd>
          {pull.linkedSessions.length > 0 ? (
            <>
              <dt className="text-muted-foreground self-start pt-px">Shuttle</dt>
              <dd className="flex min-w-0 flex-col gap-1">
                {pull.linkedSessions.map((session) => (
                  <LinkedSessionRow key={`${session.runId}:${session.role}`} session={session} />
                ))}
              </dd>
            </>
          ) : null}
          {stack ? (
            <>
              <dt className="text-muted-foreground self-start pt-1.5">Stack</dt>
              <dd className="min-w-0">
                <StackLadder
                  stack={stack}
                  highlight={pull}
                  onOpenPull={(layer) => onOpenPull(pullKey(layer.fullName, layer.number))}
                />
              </dd>
            </>
          ) : siblings.length > 0 ? (
            <>
              <dt className="text-muted-foreground self-start pt-1.5">Also opened</dt>
              <dd className="-mx-1.5 flex min-w-0 flex-col">
                {siblings.map((sibling) => (
                  <button
                    key={pullKey(sibling.fullName, sibling.number)}
                    type="button"
                    onClick={() => onOpenPull(pullKey(sibling.fullName, sibling.number))}
                    title={sibling.title}
                    className="hover:bg-accent/50 focus-visible:bg-accent/60 flex h-7 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left transition-colors duration-100 outline-none"
                  >
                    <RepoDot fullName={sibling.fullName} />
                    <span className="text-muted-foreground shrink-0">
                      {repoShortName(sibling.fullName)}
                    </span>
                    <span className="text-muted-foreground/70 shrink-0 font-mono text-[10px]">
                      #{sibling.number}
                    </span>
                    <span className="min-w-0 truncate" dir="auto">
                      {sibling.title}
                    </span>
                    <CheckGlyph rollup={sibling.checkRollup} className="ml-auto" />
                  </button>
                ))}
              </dd>
            </>
          ) : null}
        </dl>

        <section>
          <h3 className="text-muted-foreground mb-1.5 text-[11px] font-medium">Description</h3>
          {body ? (
            <div dir="auto" className="bg-card/60 rounded-lg border px-3.5 py-3">
              <Markdown text={body} className="text-[12.5px] leading-relaxed wrap-anywhere" />
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">No description provided.</p>
          )}
        </section>
      </div>

      <footer className="flex flex-col gap-2 border-t px-5 py-3">
        {error ? <p className="text-status-failed text-xs wrap-anywhere">{error}</p> : null}
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" asChild>
            <a href={pull.url} target="_blank" rel="noreferrer">
              <ExternalLink />
              GitHub
            </a>
          </Button>
          <div className="ml-auto flex items-center gap-2">
            {pull.reviewDecision === 'changes_requested' ? (
              <Button
                variant="outline"
                size="sm"
                disabled={pending !== null}
                onClick={() => start('feedback')}
              >
                {pending === 'feedback' ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <MessageSquareReply />
                )}
                Address feedback
              </Button>
            ) : null}
            {pull.reviewingRunId ? (
              <Button variant="brand" size="sm" asChild>
                <Link to="/sessions/$sessionId" params={{ sessionId: pull.reviewingRunId }}>
                  <GitPullRequest />
                  Open review
                </Link>
              </Button>
            ) : (
              <Button
                variant="brand"
                size="sm"
                disabled={pending !== null}
                onClick={() => start('review')}
              >
                {pending === 'review' ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <GitPullRequest />
                )}
                Review with Shuttle
              </Button>
            )}
          </div>
        </div>
      </footer>
    </>
  )
}

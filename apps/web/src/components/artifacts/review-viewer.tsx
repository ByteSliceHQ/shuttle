import { PatchDiff, type SelectedLineRange } from '@pierre/diffs/react'
import {
  Check,
  ChevronRight,
  ExternalLink,
  GitPullRequest,
  LoaderCircle,
  RefreshCw,
} from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

import { Markdown } from '@/components/markdown'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/panel'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { decideStructuredApproval } from '@/lib/api'
import { authClient } from '@/lib/auth-client'
import { cn, errorMessage } from '@/lib/cn'
import {
  GithubNotConnectedError,
  postPullComment,
  pullThreads,
  setPullThreadResolved,
  syncPullThreads,
  type CommentTarget,
  type PullThread,
} from '@/lib/pull-threads'
import { pullInbox, pullKey, pullOfSession, usePullsRunId } from '@/lib/pulls'
import { anchorsIn, reviewFiles, type ReviewFile } from '@/lib/review-diff'
import { fetchSandboxDiff } from '@/lib/sandbox'
import { sessionFeed, type DraftReviewComment } from '@/lib/session-feed'
import { compactRelativeTime, fullDateTime } from '@/lib/time'
import { useNow } from '@/lib/use-now'
import { useProjection, useRunStore } from '@swirls/looms/react'

import { FILE_OPTIONS, SURFACE_STYLE } from './diff-style'

/**
 * A review session's review: the pull request's diff with everything said about it in place.
 * Threads already on GitHub sit on the lines they are about, beside the comments the reviewer
 * has drafted and not yet sent. Drafts can be reworded or left out before the review goes.
 */

type Verdict = 'approve' | 'request_changes' | 'comment'

interface EditableComment extends DraftReviewComment {
  readonly enabled: boolean
  readonly editedBody: string
}

/** What sits on one line of one side of a file's diff. */
interface LineNotes {
  readonly drafts: readonly EditableComment[]
  readonly threads: readonly PullThread[]
}

// Long lines wrap: the tab is narrow, and a diff that scrolls sideways carries the threads on
// it out of view along with the code.
const DIFF_OPTIONS = {
  ...FILE_OPTIONS,
  diffStyle: 'unified',
  overflow: 'wrap',
} as const

/** The lines a new comment is about. `line` is the last of them, where the comment sits. */
interface CommentRange {
  readonly startLine: number
  readonly startSide: 'LEFT' | 'RIGHT'
  readonly line: number
  readonly side: 'LEFT' | 'RIGHT'
}

const sideOf = (side: SelectedLineRange['side']) => (side === 'deletions' ? 'LEFT' : 'RIGHT')

/** The lines picked with the gutter button, first to last whichever way they were dragged. */
function commentRange(picked: SelectedLineRange): CommentRange {
  const from = { line: picked.start, side: sideOf(picked.side) } as const
  const to = { line: picked.end, side: sideOf(picked.endSide ?? picked.side) } as const
  const [first, last] = from.line <= to.line ? [from, to] : [to, from]

  return { startLine: first.line, startSide: first.side, line: last.line, side: last.side }
}

const linesLabel = (start: number, end: number) =>
  start === end ? `line ${end}` : `lines ${start}–${end}`

/**
 * What the person looking can do on the pull request in their own name. Null when the review is
 * not tied to a pull request they can reach, so there is nowhere for a comment to go.
 */
interface ReviewActions {
  readonly comment: (target: CommentTarget, body: string) => Promise<void>
  readonly resolve: (rootId: number, resolved: boolean) => Promise<void>
}

const ReviewActionsContext = createContext<ReviewActions | null>(null)

const VERDICT_LABEL: Record<Verdict, string> = {
  comment: 'Comment',
  approve: 'Approve',
  request_changes: 'Request changes',
}

/** A comment's text as GitHub shows it, with a proposed replacement as a suggestion block. */
function withSuggestion(body: string, suggestion: string | undefined): string {
  return suggestion ? `${body}\n\n\`\`\`suggestion\n${suggestion}\n\`\`\`` : body
}

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`

export function ReviewViewer({ runId, folderId }: { runId: string; folderId?: string }) {
  const feed = useProjection(useRunStore(runId), sessionFeed)
  const pullsStore = useRunStore(usePullsRunId())
  const inbox = useProjection(pullsStore, pullInbox)
  const mirrored = useProjection(pullsStore, pullThreads)
  const pull = useMemo(() => pullOfSession(inbox, runId), [inbox, runId])

  const threads = useMemo(
    () => (pull ? (mirrored.pulls[pullKey(pull.fullName, pull.number)] ?? []) : []),
    [mirrored, pull],
  )

  const [diffText, setDiffText] = useState<string | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)

  // Until someone edits them, the summary and verdict are the ones the reviewer proposed.
  const [summaryEdit, setSummary] = useState<string | null>(null)
  const [verdictEdit, setVerdict] = useState<Verdict | null>(null)
  const summary = summaryEdit ?? feed.reviewProposal?.summary ?? ''
  const verdict = verdictEdit ?? feed.reviewProposal?.verdict ?? 'comment'
  const outcome = feed.reviewOutcome
  const approvalId = feed.pendingReviewApprovalId

  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [edits, setEdits] = useState<Record<string, { enabled?: boolean; editedBody?: string }>>({})

  const drafts: EditableComment[] = useMemo(
    () =>
      feed.draftReviewComments.map((draft) => {
        const edit = edits[draft.commentId]

        return {
          ...draft,
          enabled: edit?.enabled ?? true,
          editedBody: edit?.editedBody ?? draft.body,
        }
      }),
    [edits, feed.draftReviewComments],
  )

  const updateDraft = useCallback((next: EditableComment) => {
    setEdits((prev) => ({
      ...prev,
      [next.commentId]: { enabled: next.enabled, editedBody: next.editedBody },
    }))
  }, [])

  useEffect(() => {
    let cancelled = false

    void fetchSandboxDiff({ runId })
      .then((result) => {
        if (!cancelled) {
          setDiffText(result.diffs.map((entry) => entry.diff).join('\n'))
          setDiffError(null)
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setDiffError(errorMessage(cause))
          setDiffText('')
        }
      })

    return () => {
      cancelled = true
    }
  }, [runId])

  // Webhooks keep the threads current, but only from when Shuttle was connected and only when
  // every delivery arrives, so GitHub is asked for the whole set whenever the review is opened.
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const fullName = pull?.fullName
  const number = pull?.number

  const sync = useCallback(() => {
    if (!folderId || !fullName || number === undefined) {
      return
    }

    setSyncing(true)

    void syncPullThreads(folderId, fullName, number)
      .then(() => setSyncError(null))
      .catch((cause: unknown) => setSyncError(errorMessage(cause)))
      .finally(() => setSyncing(false))
  }, [folderId, fullName, number])

  const synced = useRef<string | null>(null)

  useEffect(() => {
    const key = folderId && fullName && number !== undefined ? `${fullName}#${number}` : null

    if (key && synced.current !== key) {
      synced.current = key
      sync()
    }
  }, [folderId, fullName, number, sync])

  const actions = useMemo<ReviewActions | null>(
    () =>
      folderId && fullName && number !== undefined
        ? {
            comment: (target, body) => postPullComment(folderId, fullName, number, target, body),
            resolve: (rootId, resolved) =>
              setPullThreadResolved(folderId, fullName, number, rootId, resolved),
          }
        : null,
    [folderId, fullName, number],
  )

  const files = useMemo(() => (diffText ? reviewFiles(diffText) : []), [diffText])

  // Everything said, sorted into the file it is about, and within it onto a line when the diff
  // still shows that line. The rest is listed above the file's diff, or under no file at all.
  const placed = useMemo(() => {
    const byPath = new Map(files.map((file) => [file.path, file]))

    const perFile = new Map<
      string,
      { lines: Map<string, LineNotes>; loose: { drafts: EditableComment[]; threads: PullThread[] } }
    >()

    const elsewhere: { drafts: EditableComment[]; threads: PullThread[] } = {
      drafts: [],
      threads: [],
    }

    const slot = (path: string) => {
      let entry = perFile.get(path)

      if (!entry) {
        entry = { lines: new Map(), loose: { drafts: [], threads: [] } }
        perFile.set(path, entry)
      }

      return entry
    }

    const onLine = (
      file: ReviewFile,
      side: 'LEFT' | 'RIGHT',
      line: number,
      add: (notes: LineNotes) => LineNotes,
    ) => {
      const { lines } = slot(file.path)
      const key = `${side}:${line}`

      lines.set(key, add(lines.get(key) ?? { drafts: [], threads: [] }))
    }

    for (const draft of drafts) {
      const file = byPath.get(draft.path)

      if (!file) {
        elsewhere.drafts.push(draft)
      } else if (anchorsIn(file, draft.side, draft.line)) {
        onLine(file, draft.side, draft.line, (notes) => ({
          ...notes,
          drafts: [...notes.drafts, draft],
        }))
      } else {
        slot(file.path).loose.drafts.push(draft)
      }
    }

    for (const thread of threads) {
      const first = thread.comments[0]

      if (!first) {
        continue
      }

      const file = byPath.get(first.path)

      if (!file) {
        elsewhere.threads.push(thread)
      } else if (
        !first.outdated &&
        first.line !== null &&
        anchorsIn(file, first.side, first.line)
      ) {
        onLine(file, first.side, first.line, (notes) => ({
          ...notes,
          threads: [...notes.threads, thread],
        }))
      } else {
        slot(file.path).loose.threads.push(thread)
      }
    }

    return { perFile, elsewhere }
  }, [drafts, files, threads])

  const included = drafts.filter((draft) => draft.enabled).length
  const open = threads.filter((thread) => !thread.resolved).length

  async function submit() {
    if (!approvalId) {
      return
    }

    setPending(true)
    setError(null)

    try {
      await decideStructuredApproval(runId, approvalId, {
        actionId: 'submit',
        outcome: 'approve',
        payload: {
          summary: summary.trim() || 'Shuttle review',
          verdict,
          comments: drafts
            .filter((draft) => draft.enabled)
            .map((draft) => ({
              path: draft.path,
              line: draft.line,
              side: draft.side,
              body: withSuggestion(draft.editedBody.trim() || draft.body, draft.suggestion),
            })),
        },
      })
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setPending(false)
    }
  }

  const nothingYet = drafts.length === 0 && threads.length === 0 && files.length === 0

  if (nothingYet && diffText !== null && !syncing) {
    return (
      <EmptyState icon={<GitPullRequest />} title="Nothing to review yet">
        {diffError ??
          'The pull request’s changes, the threads on it and the comments the reviewer drafts all show up here.'}
      </EmptyState>
    )
  }

  const showForm = Boolean(approvalId) || drafts.length > 0 || outcome !== undefined

  return (
    <ReviewActionsContext.Provider value={actions}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="text-muted-foreground flex h-8 shrink-0 items-center gap-2 border-b px-2.5 text-[11px]">
          <GitPullRequest aria-hidden className="size-3 shrink-0" />
          {pull ? (
            <a
              href={pull.url}
              target="_blank"
              rel="noreferrer"
              title={`${pull.fullName}#${pull.number}: ${pull.title}`}
              className="text-foreground hover:text-brand min-w-0 truncate outline-none focus-visible:underline"
            >
              <span className="tabular-nums">#{pull.number}</span> {pull.title}
            </a>
          ) : (
            <span className="text-foreground">Review</span>
          )}
          <span className="ml-auto shrink-0 tabular-nums">
            {[
              drafts.length > 0 ? plural(drafts.length, 'draft') : null,
              threads.length > 0
                ? `${open} open of ${plural(threads.length, 'thread')}`
                : 'no threads on GitHub',
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
          {folderId && pull ? (
            <button
              type="button"
              onClick={sync}
              disabled={syncing}
              title={syncError ?? 'Fetch the threads on this pull request from GitHub again'}
              aria-label="Refresh threads from GitHub"
              className={cn(
                'hover:text-foreground focus-visible:ring-ring/50 shrink-0 rounded-sm p-0.5 outline-none focus-visible:ring-2',
                syncError && 'text-status-failed',
              )}
            >
              <RefreshCw className={cn('size-3', syncing && 'animate-spin')} />
            </button>
          ) : null}
        </div>

        {syncError ? (
          <p
            role="alert"
            className="text-status-failed shrink-0 border-b px-3 py-1.5 text-[11.5px]"
          >
            The threads on GitHub could not be read, so these may be out of date. {syncError}
          </p>
        ) : null}

        {showForm ? (
          <div className="flex shrink-0 flex-col gap-2 border-b px-3 py-2.5">
            <Textarea
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              placeholder="Summary of the review"
              aria-label="Summary of the review"
              className="min-h-14 resize-none text-[12.5px]"
              disabled={pending || !approvalId}
            />
            <div className="flex flex-wrap items-center gap-2">
              {(['comment', 'approve', 'request_changes'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  disabled={pending || !approvalId}
                  aria-pressed={verdict === option}
                  onClick={() => setVerdict(option)}
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
                    verdict === option
                      ? 'border-brand/40 bg-brand/10 text-brand'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {VERDICT_LABEL[option]}
                </button>
              ))}
              <div className="ml-auto flex items-center gap-2">
                {error ? <span className="text-status-failed text-[11px]">{error}</span> : null}
                {approvalId ? (
                  <Button
                    type="button"
                    variant="brand"
                    size="sm"
                    disabled={pending}
                    onClick={() => void submit()}
                  >
                    {pending ? (
                      <LoaderCircle className="size-3.5 animate-spin" />
                    ) : (
                      <Check className="size-3.5" />
                    )}
                    Send {included > 0 ? plural(included, 'comment') : 'review'}
                  </Button>
                ) : (
                  <span className="text-muted-foreground text-[11px]">
                    {outcome?.status === 'submitted'
                      ? 'Sent to GitHub'
                      : outcome?.status === 'failed'
                        ? 'Not sent'
                        : 'The reviewer is still drafting…'}
                  </span>
                )}
              </div>
            </div>
          </div>
        ) : null}

        {outcome?.status === 'failed' ? (
          <p
            role="alert"
            className="text-status-failed shrink-0 border-b px-3 py-2 text-[12px] leading-snug wrap-anywhere"
          >
            GitHub did not take the review, so nothing was posted. {outcome.error} Ask the reviewer
            to submit again once this is sorted out.
          </p>
        ) : outcome?.status === 'submitted' ? (
          <p className="text-muted-foreground shrink-0 border-b px-3 py-2 text-[12px] leading-snug">
            Review sent to GitHub with {plural(outcome.commentCount, 'inline comment')}.
            {outcome.unanchoredCount > 0
              ? ` ${outcome.unanchoredCount} more could not be placed on a line of the diff and went in the review's summary.`
              : ''}
          </p>
        ) : null}

        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-5 py-3">
            {diffError && !nothingYet ? (
              <p className="text-status-failed px-3 text-xs">
                The pull request’s changes could not be loaded. {diffError}
              </p>
            ) : diffText === null ? (
              <p className="text-muted-foreground px-3 text-xs">Loading changes…</p>
            ) : null}

            {files.map((file) => (
              <FileReview
                key={file.path}
                file={file}
                notes={placed.perFile.get(file.path)}
                onDraftChange={updateDraft}
              />
            ))}

            {placed.elsewhere.drafts.length > 0 || placed.elsewhere.threads.length > 0 ? (
              <section className="flex flex-col gap-2 px-3">
                <h3 className="text-muted-foreground text-[11px] font-medium">
                  On files these changes no longer touch
                </h3>
                <NoteList
                  drafts={placed.elsewhere.drafts}
                  threads={placed.elsewhere.threads}
                  onDraftChange={updateDraft}
                  showPath
                />
              </section>
            ) : null}
          </div>
        </ScrollArea>
      </div>
    </ReviewActionsContext.Provider>
  )
}

/** One file of the pull request: its diff, with what was said about it on the lines it is about. */
function FileReview({
  file,
  notes,
  onDraftChange,
}: {
  file: ReviewFile
  notes:
    | {
        lines: Map<string, LineNotes>
        loose: { drafts: EditableComment[]; threads: PullThread[] }
      }
    | undefined
  onDraftChange: (next: EditableComment) => void
}) {
  const actions = useContext(ReviewActionsContext)

  // The lines a new comment is being written on. It sits under the last of them.
  const [range, setRange] = useState<CommentRange | null>(null)
  const composing = range ? `${range.side}:${range.line}` : null

  const annotations = useMemo(() => {
    const lines = new Map(notes?.lines)

    if (composing && !lines.has(composing)) {
      lines.set(composing, { drafts: [], threads: [] })
    }

    return [...lines].map(([key, metadata]) => {
      const [side, line] = key.split(':')

      return {
        side: side === 'LEFT' ? ('deletions' as const) : ('additions' as const),
        lineNumber: Number(line),
        metadata: { ...metadata, key },
      }
    })
  }, [notes, composing])

  // The diff's own gutter button starts a comment on the line it is pressed on, or on every
  // line it is dragged across.
  const options = useMemo(
    () =>
      actions
        ? {
            ...DIFF_OPTIONS,
            enableGutterUtility: true,
            onGutterUtilityClick: (picked: SelectedLineRange) => setRange(commentRange(picked)),
          }
        : DIFF_OPTIONS,
    [actions],
  )

  // The diff keeps a pressed line selected, and pins its gutter button there, until told
  // otherwise. Only the line being commented on stays selected; with none, nothing is.
  const selected = useMemo<SelectedLineRange | null>(
    () =>
      range
        ? {
            start: range.startLine,
            side: range.startSide === 'LEFT' ? 'deletions' : 'additions',
            end: range.line,
            endSide: range.side === 'LEFT' ? 'deletions' : 'additions',
          }
        : null,
    [range],
  )

  const count =
    (notes?.loose.drafts.length ?? 0) +
    (notes?.loose.threads.length ?? 0) +
    annotations.reduce(
      (total, annotation) =>
        total + annotation.metadata.drafts.length + annotation.metadata.threads.length,
      0,
    )

  return (
    <section className="min-w-0">
      <header className="bg-background sticky top-0 z-10 flex items-baseline gap-2 border-b px-3 py-1.5 font-mono text-[11px]">
        <span className="text-foreground min-w-0 truncate font-medium" title={file.path}>
          {file.path}
        </span>
        <span className="text-status-completed shrink-0 tabular-nums">+{file.additions}</span>
        <span className="text-destructive shrink-0 tabular-nums">−{file.deletions}</span>
        {count > 0 ? (
          <span className="text-muted-foreground ml-auto shrink-0 font-sans tabular-nums">
            {plural(count, 'comment thread')}
          </span>
        ) : null}
      </header>

      {notes && (notes.loose.drafts.length > 0 || notes.loose.threads.length > 0) ? (
        <div className="flex flex-col gap-2 border-b px-3 py-2">
          <p className="text-muted-foreground text-[11px]">On lines these changes no longer show</p>
          <NoteList
            drafts={notes.loose.drafts}
            threads={notes.loose.threads}
            onDraftChange={onDraftChange}
          />
        </div>
      ) : null}

      <div style={SURFACE_STYLE}>
        <PatchDiff
          patch={file.patch}
          options={options}
          selectedLines={selected}
          lineAnnotations={annotations}
          renderAnnotation={(annotation) => {
            const { key, drafts, threads } = annotation.metadata

            return (
              // Zero width that then fills its column: what is written here never widens the
              // code it sits in, however long a line of it is.
              <div className="bg-muted/30 border-border/60 flex w-0 min-w-full flex-col gap-2 border-y px-3 py-2 font-sans">
                <NoteList drafts={drafts} threads={threads} onDraftChange={onDraftChange} />
                {actions && range && composing === key ? (
                  <Composer
                    label={`Comment on ${file.path} ${linesLabel(range.startLine, range.line)}`}
                    placeholder={
                      range.startLine === range.line
                        ? 'Start a thread on this line'
                        : `Start a thread on ${linesLabel(range.startLine, range.line)}`
                    }
                    send="Comment"
                    autoFocus
                    onCancel={() => setRange(null)}
                    onSend={async (body) => {
                      await actions.comment(
                        {
                          path: file.path,
                          line: range.line,
                          side: range.side,
                          ...(range.startLine === range.line
                            ? {}
                            : { startLine: range.startLine, startSide: range.startSide }),
                        },
                        body,
                      )

                      setRange(null)
                    }}
                  />
                ) : null}
              </div>
            )
          }}
        />
      </div>
    </section>
  )
}

function NoteList({
  drafts,
  threads,
  onDraftChange,
  showPath,
}: {
  drafts: readonly EditableComment[]
  threads: readonly PullThread[]
  onDraftChange: (next: EditableComment) => void
  showPath?: boolean
}) {
  return (
    <>
      {threads.map((thread) => (
        <ThreadCard key={thread.rootId} thread={thread} showPath={showPath} />
      ))}
      {drafts.map((draft) => (
        <DraftCard
          key={draft.commentId}
          draft={draft}
          onChange={onDraftChange}
          showPath={showPath}
        />
      ))}
    </>
  )
}

/** A thread from GitHub. A resolved one is folded to a line until it is opened. */
function ThreadCard({ thread, showPath }: { thread: PullThread; showPath?: boolean }) {
  const now = useNow()
  const actions = useContext(ReviewActionsContext)
  const [replying, setReplying] = useState(false)
  const [resolving, setResolving] = useState(false)
  const [resolveError, setResolveError] = useState<string | null>(null)
  const [opened, setOpened] = useState<boolean | null>(null)
  const expanded = opened ?? !thread.resolved
  const first = thread.comments[0]

  if (!first) {
    return null
  }

  return (
    <div className="bg-card rounded-md border text-[12px]">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setOpened(!expanded)}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11px] outline-none focus-visible:ring-2"
      >
        <ChevronRight
          aria-hidden
          className={cn('size-3 shrink-0 transition-transform', expanded && 'rotate-90')}
        />
        <span className="text-foreground shrink-0 font-medium">{first.author.login}</span>
        {thread.comments.length > 1 ? (
          <span className="shrink-0">
            +{plural(thread.comments.length - 1, 'reply', 'replies')}
          </span>
        ) : null}
        {showPath || first.outdated ? (
          <span className="min-w-0 truncate font-mono">
            {first.path}
            {first.line === null ? '' : `:${first.line}`}
          </span>
        ) : null}
        {first.startLine !== undefined && first.line !== null && first.startLine !== first.line ? (
          <span className="shrink-0">{linesLabel(first.startLine, first.line)}</span>
        ) : null}
        {expanded ? null : <span className="min-w-0 flex-1 truncate">{first.body}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {first.outdated ? <span>Outdated</span> : null}
          {thread.resolved ? (
            <span className="text-status-completed flex items-center gap-0.5">
              <Check aria-hidden className="size-3" />
              Resolved
            </span>
          ) : null}
        </span>
      </button>

      {expanded ? (
        <ul className="flex flex-col border-t">
          {thread.comments.map((comment) => (
            <li key={comment.commentId} className="flex gap-2 px-2 py-1.5 not-first:border-t">
              {comment.author.avatarUrl ? (
                <img
                  src={comment.author.avatarUrl}
                  alt=""
                  className="mt-0.5 size-4 shrink-0 rounded-full"
                />
              ) : (
                <span aria-hidden className="bg-muted mt-0.5 size-4 shrink-0 rounded-full" />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
                  <span className="text-foreground font-medium">{comment.author.login}</span>
                  <time title={fullDateTime(comment.createdAt)}>
                    {compactRelativeTime(comment.createdAt, now)}
                  </time>
                  {comment.updatedAt > comment.createdAt ? <span>edited</span> : null}
                  <a
                    href={comment.url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Open this comment on GitHub"
                    title="Open on GitHub"
                    className="hover:text-foreground ml-auto shrink-0 outline-none focus-visible:underline"
                  >
                    <ExternalLink className="size-3" />
                  </a>
                </p>
                <Markdown
                  text={comment.body}
                  className="text-[12px] leading-relaxed wrap-anywhere"
                />
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {expanded && actions ? (
        <div className="flex flex-col gap-1.5 border-t px-2 py-1.5">
          {replying ? (
            <Composer
              label={`Reply to ${first.author.login}`}
              placeholder="Reply"
              send="Reply"
              autoFocus
              onCancel={() => setReplying(false)}
              onSend={async (body) => {
                await actions.comment({ rootId: thread.rootId }, body)
                setReplying(false)
              }}
            />
          ) : (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setReplying(true)}
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 bg-background min-w-0 flex-1 rounded-sm border px-2 py-1 text-left text-[11.5px] outline-none focus-visible:ring-2"
              >
                Reply…
              </button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={resolving}
                onClick={() => {
                  setResolving(true)
                  setResolveError(null)

                  void actions
                    .resolve(thread.rootId, !thread.resolved)
                    .catch((cause: unknown) => setResolveError(errorMessage(cause)))
                    .finally(() => setResolving(false))
                }}
              >
                {resolving ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
                {thread.resolved ? 'Reopen' : 'Resolve'}
              </Button>
            </div>
          )}
          {resolveError ? (
            <p role="alert" className="text-status-failed text-[11px] wrap-anywhere">
              {resolveError}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Where the person writes something that goes to GitHub in their own name. Nothing is posted
 * until they send it, and what they wrote stays put if GitHub does not take it.
 */
function Composer({
  label,
  placeholder,
  send,
  autoFocus,
  onSend,
  onCancel,
}: {
  label: string
  placeholder: string
  send: string
  autoFocus?: boolean
  onSend: (body: string) => Promise<void>
  onCancel: () => void
}) {
  const [body, setBody] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [needsGithub, setNeedsGithub] = useState(false)

  function submit() {
    if (!body.trim() || pending) {
      return
    }

    setPending(true)
    setError(null)

    void onSend(body.trim())
      .catch((cause: unknown) => {
        setNeedsGithub(cause instanceof GithubNotConnectedError)
        setError(errorMessage(cause))
      })
      .finally(() => setPending(false))
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            submit()
          } else if (event.key === 'Escape' && !body.trim()) {
            onCancel()
          }
        }}
        placeholder={placeholder}
        aria-label={label}
        autoFocus={autoFocus}
        disabled={pending}
        className="bg-background min-h-14 resize-none text-[12px]"
      />
      {error ? (
        <p role="alert" className="text-status-failed text-[11px] wrap-anywhere">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1.5">
        <span className="text-muted-foreground mr-auto text-[11px] whitespace-nowrap">
          Posts to GitHub as you
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          {needsGithub ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                void authClient.linkSocial({
                  provider: 'github',
                  callbackURL: window.location.href,
                  // A refusal comes back here too, not to a page outside the app.
                  errorCallbackURL: window.location.href,
                })
              }
            >
              Connect GitHub
            </Button>
          ) : null}
          <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="brand"
            size="sm"
            disabled={pending || !body.trim()}
            onClick={submit}
          >
            {pending ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
            {send}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** A comment the reviewer drafted. Nothing here is on GitHub until the review is sent. */
function DraftCard({
  draft,
  onChange,
  showPath,
}: {
  draft: EditableComment
  onChange: (next: EditableComment) => void
  showPath?: boolean
}) {
  const tint =
    draft.severity === 'error'
      ? 'border-destructive/40 bg-destructive/8'
      : draft.severity === 'warning'
        ? 'border-status-waiting/40 bg-status-waiting/8'
        : 'border-brand/30 bg-brand/6'

  return (
    <div className={cn('rounded-md border p-2', tint, !draft.enabled && 'opacity-50')}>
      <div className="mb-1.5 flex items-center gap-2 text-[11px]">
        <label className="flex items-center gap-1.5 font-medium">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => onChange({ ...draft, enabled: event.target.checked })}
            className="size-3"
          />
          Draft
        </label>
        <span className="text-muted-foreground">{draft.severity}</span>
        {showPath ? (
          <span className="text-muted-foreground min-w-0 truncate font-mono">
            {draft.path}:{draft.line}
          </span>
        ) : null}
        <span className="text-muted-foreground ml-auto shrink-0">
          {draft.enabled ? 'Will be sent' : 'Left out'}
        </span>
      </div>
      <Textarea
        value={draft.editedBody}
        onChange={(event) => onChange({ ...draft, editedBody: event.target.value })}
        disabled={!draft.enabled}
        aria-label={`Draft comment on ${draft.path} line ${draft.line}`}
        className="min-h-14 resize-none text-[12px]"
      />
      {draft.suggestion ? (
        <div className="mt-1.5">
          <p className="text-muted-foreground mb-1 text-[10px] font-medium">Suggested change</p>
          <pre className="bg-status-completed/10 overflow-x-auto rounded-sm px-2 py-1.5 font-mono text-[11px] leading-[18px] whitespace-pre">
            {draft.suggestion}
          </pre>
        </div>
      ) : null}
    </div>
  )
}

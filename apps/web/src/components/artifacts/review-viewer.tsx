import { Check, GitPullRequest, LoaderCircle, MessageSquareWarning } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/panel'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { decideStructuredApproval } from '@/lib/api'
import { cn, errorMessage } from '@/lib/cn'
import { fetchSandboxDiff } from '@/lib/sandbox'
import { sessionFeed, type DraftReviewComment } from '@/lib/session-feed'
import { parseUnifiedDiff } from '@/lib/unified-diff'
import { useProjection, useRunStore } from '@swirls/looms/react'

type Verdict = 'approve' | 'request_changes' | 'comment'

interface EditableComment extends DraftReviewComment {
  readonly enabled: boolean
  readonly editedBody: string
}

export function ReviewViewer({ runId }: { runId: string }) {
  const store = useRunStore(runId)
  const feed = useProjection(store, sessionFeed)
  const [diffText, setDiffText] = useState<string | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [summary, setSummary] = useState('Shuttle review')
  const [verdict, setVerdict] = useState<Verdict>('comment')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [edits, setEdits] = useState<Record<string, { enabled?: boolean; editedBody?: string }>>({})

  const comments: EditableComment[] = useMemo(
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

  function updateComment(next: EditableComment) {
    setEdits((prev) => ({
      ...prev,
      [next.commentId]: {
        enabled: next.enabled,
        editedBody: next.editedBody,
      },
    }))
  }

  useEffect(() => {
    let cancelled = false

    void fetchSandboxDiff({ runId })
      .then((result) => {
        if (cancelled) {
          return
        }

        const combined = result.diffs.map((entry) => entry.diff).join('\n')
        setDiffText(combined)
        setDiffError(null)
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setDiffError(cause instanceof Error ? cause.message : 'Failed to load diff')
          setDiffText('')
        }
      })

    return () => {
      cancelled = true
    }
  }, [runId])

  const files = useMemo(() => {
    if (!diffText) {
      return []
    }

    return parseUnifiedDiff(diffText, 'worktree')
  }, [diffText])

  const commentsByPath = useMemo(() => {
    const map = new Map<string, EditableComment[]>()

    for (const comment of comments) {
      const list = map.get(comment.path) ?? []
      list.push(comment)
      map.set(comment.path, list)
    }

    return map
  }, [comments])

  const approvalId = feed.pendingReviewApprovalId

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
          summary,
          verdict,
          comments: comments
            .filter((comment) => comment.enabled)
            .map((comment) => ({
              path: comment.path,
              line: comment.line,
              side: comment.side,
              body: comment.editedBody.trim() || comment.body,
            })),
        },
      })
    } catch (cause) {
      setError(errorMessage(cause))
      setPending(false)
    }
  }

  if (comments.length === 0 && files.length === 0 && diffText !== null) {
    return (
      <EmptyState icon={<GitPullRequest />} title="No draft review yet">
        The reviewer agent will draft inline comments here. Approve the submit gate when ready.
      </EmptyState>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-b px-3 py-2.5">
        <div className="flex items-center gap-2 text-[12px] font-medium">
          <MessageSquareWarning className="text-brand size-3.5" />
          Draft review
          <span className="text-muted-foreground font-normal tabular-nums">
            {comments.filter((comment) => comment.enabled).length}/{comments.length} comments
          </span>
        </div>
        <Textarea
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          placeholder="Review summary"
          className="min-h-16 resize-none text-[12.5px]"
          disabled={pending || !approvalId}
        />
        <div className="flex flex-wrap items-center gap-2">
          {(['comment', 'approve', 'request_changes'] as const).map((option) => (
            <button
              key={option}
              type="button"
              disabled={pending || !approvalId}
              onClick={() => setVerdict(option)}
              className={cn(
                'rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
                verdict === option
                  ? 'border-brand/40 bg-brand/10 text-brand'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {option === 'request_changes'
                ? 'Request changes'
                : option === 'approve'
                  ? 'Approve'
                  : 'Comment'}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2">
            {error ? <span className="text-status-failed text-[11px]">{error}</span> : null}
            {!approvalId ? (
              <span className="text-muted-foreground text-[11px]">Waiting for submit gate…</span>
            ) : (
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
                Submit review
              </Button>
            )}
          </div>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-3">
          {diffError ? (
            <p className="text-status-failed text-xs">{diffError}</p>
          ) : diffText === null ? (
            <p className="text-muted-foreground text-xs">Loading diff…</p>
          ) : null}

          {files.length === 0 && comments.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {comments.map((comment) => (
                <CommentEditor key={comment.commentId} comment={comment} onChange={updateComment} />
              ))}
            </ul>
          ) : null}

          {files.map((file) => {
            const pathComments = commentsByPath.get(file.path) ?? []

            return (
              <section key={`${file.repo}:${file.path}`} className="min-w-0">
                <header className="text-foreground mb-1.5 flex items-baseline gap-2 font-mono text-[11px]">
                  <span className="min-w-0 truncate font-medium">{file.path}</span>
                  {pathComments.length > 0 ? (
                    <span className="text-muted-foreground tabular-nums">
                      {pathComments.length} comment{pathComments.length === 1 ? '' : 's'}
                    </span>
                  ) : null}
                </header>
                <pre className="bg-card overflow-x-auto rounded-md border p-2 font-mono text-[11px] leading-[18px]">
                  {file.lines.map((line, index) => {
                    const anchored =
                      line.newLine !== undefined
                        ? pathComments.filter(
                            (comment) => comment.side === 'RIGHT' && comment.line === line.newLine,
                          )
                        : []

                    return (
                      <div key={index}>
                        <div
                          className={cn(
                            'whitespace-pre',
                            line.kind === 'add' && 'bg-status-completed/10 text-status-completed',
                            line.kind === 'del' && 'bg-destructive/10 text-destructive',
                            line.kind === 'hunk' && 'text-muted-foreground',
                            anchored.length > 0 && 'ring-brand/30 ring-1 ring-inset',
                          )}
                        >
                          {line.text}
                        </div>
                        {anchored.map((comment) => (
                          <div key={comment.commentId} className="my-1.5 ml-4">
                            <CommentEditor comment={comment} onChange={updateComment} />
                          </div>
                        ))}
                      </div>
                    )
                  })}
                </pre>
              </section>
            )
          })}
        </div>
      </ScrollArea>
    </div>
  )
}

function CommentEditor({
  comment,
  onChange,
}: {
  comment: EditableComment
  onChange: (next: EditableComment) => void
}) {
  const tint =
    comment.severity === 'error'
      ? 'border-destructive/40 bg-destructive/8'
      : comment.severity === 'warning'
        ? 'border-status-waiting/40 bg-status-waiting/8'
        : 'border-brand/30 bg-brand/6'

  return (
    <div className={cn('rounded-md border p-2', tint, !comment.enabled && 'opacity-50')}>
      <div className="mb-1.5 flex items-center gap-2 text-[10px] font-medium tracking-wide uppercase">
        <label className="flex items-center gap-1.5 normal-case">
          <input
            type="checkbox"
            checked={comment.enabled}
            onChange={(event) => onChange({ ...comment, enabled: event.target.checked })}
            className="size-3"
          />
          Include
        </label>
        <span className="text-muted-foreground">{comment.severity}</span>
        <span className="text-muted-foreground font-mono normal-case">
          {comment.path}:{comment.line}
        </span>
      </div>
      <Textarea
        value={comment.editedBody}
        onChange={(event) => onChange({ ...comment, editedBody: event.target.value })}
        disabled={!comment.enabled}
        className="min-h-14 resize-none text-[12px]"
      />
    </div>
  )
}

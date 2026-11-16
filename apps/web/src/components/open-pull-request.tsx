import { GitPullRequestArrow, LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'

import { requestPullRequest } from '@/lib/api'
import { cn, errorMessage } from '@/lib/cn'
import type { SessionFeed } from '@/lib/session-feed'

import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

/** How long to wait for the card before saying something went wrong. */
const CARD_TIMEOUT_MS = 30_000

/** Where the session's pull request stands, from the publish cards in its feed. */
export function pullRequestState(feed: SessionFeed): {
  /** A card waiting for someone to publish or discard it. */
  readonly awaiting: string | null
  /** A card that was approved and is being published now. */
  readonly publishing: boolean
} {
  let awaiting: string | null = null
  let publishing = false

  for (const item of feed.items) {
    if (item.kind !== 'question' || !item.approvalId.startsWith('pr_publish_') || item.publish) {
      continue
    }

    if (!item.decision) {
      awaiting = item.approvalId
    } else if (item.decision.answer !== null && item.decision.answer !== 'discard') {
      publishing = true
    }
  }

  return { awaiting, publishing }
}

function showCard(approvalId: string) {
  const card = document.querySelector(`[data-approval-id="${CSS.escape(approvalId)}"]`)

  card?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

/**
 * The session's PR button. It works whichever agent runs the session: it opens the publish card
 * at once, titled from the commits, and Shuttle publishes once someone approves it there.
 */
export function OpenPullRequestButton({
  runId,
  feed,
  hasPulls,
  working,
}: {
  runId: string
  feed: SessionFeed
  /** The session already opened a pull request, so this one updates it. */
  hasPulls: boolean
  /** The agents are mid-turn: a pull request now could catch half-written work. */
  working: boolean
}) {
  const [requested, setRequested] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { awaiting, publishing } = pullRequestState(feed)

  // The card the button asked for is in the feed, whatever has become of it since.
  const arrived =
    requested !== null &&
    feed.items.some((item) => item.kind === 'question' && item.approvalId === requested)

  // The card the button asked for has arrived: take the person to it.
  useEffect(() => {
    if (arrived && requested) {
      requestAnimationFrame(() => showCard(requested))
    }
  }, [arrived, requested])

  useEffect(() => {
    if (!requested || arrived) {
      return
    }

    const timer = setTimeout(() => {
      setRequested(null)
      setError('The pull request card did not appear. Try again in a moment.')
    }, CARD_TIMEOUT_MS)

    return () => clearTimeout(timer)
  }, [requested, arrived])

  const opening = requested !== null && !arrived
  const label = hasPulls ? 'Update PR' : 'Open PR'

  const disabledReason = publishing
    ? 'Publishing the pull request…'
    : working && !awaiting
      ? 'Available when the agents finish their turn'
      : null

  const tip =
    error ??
    disabledReason ??
    (awaiting
      ? 'A pull request is waiting for your approval. Show it.'
      : hasPulls
        ? 'Push the latest work to this session’s pull request. You review it before anything is published.'
        : 'Open a pull request of this session’s work. You review the title and description before anything is published.')

  function onClick() {
    setError(null)

    if (awaiting) {
      showCard(awaiting)
      return
    }

    void requestPullRequest(runId).then(
      ({ approvalId }) => setRequested(approvalId),
      (cause: unknown) => setError(errorMessage(cause)),
    )
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          disabled={opening || disabledReason !== null}
          aria-label={awaiting ? 'Show the pull request waiting for approval' : label}
          className={cn(
            'focus-visible:ring-ring/50 inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2 text-[11px] transition-colors duration-100 outline-none focus-visible:ring-2 disabled:opacity-50',
            awaiting
              ? 'border-brand/50 text-brand hover:bg-brand/10'
              : error
                ? 'border-status-failed/50 text-status-failed'
                : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {opening || publishing ? (
            <LoaderCircle className="size-3 animate-spin" />
          ) : (
            <GitPullRequestArrow className="size-3" />
          )}
          <span className="hidden @lg:inline">
            {opening ? 'Opening…' : publishing ? 'Publishing…' : awaiting ? 'Review PR' : label}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end" className="max-w-64">
        {tip}
      </TooltipContent>
    </Tooltip>
  )
}

import { useMutation } from '@tanstack/react-query'
import { ExternalLink, GitPullRequest, LoaderCircle } from 'lucide-react'
import { useState } from 'react'

import { Button } from '../../components/ui/button'
import { Textarea } from '../../components/ui/textarea'
import { cn } from '../../lib/cn'
import { jsonText } from '../../lib/json'
import { clockTime } from '../../lib/time'
import { useNow } from '../../lib/use-now'
import { useShuttleHost } from '../../shuttle'
import type { AgentIdentity } from './agents'
import { agentRole } from './agents'
import type { FeedItem, PublishedPull } from './session-feed'
import { decideStructuredApproval } from './signals'

export interface PullPublishCardContext {
  readonly runId: string
  /** Whether the proposal is shown without the means to decide it. */
  readonly readOnly: boolean
  readonly identities: ReadonlyMap<string, AgentIdentity>
  readonly onInspect: (threadId: string, seq?: number) => void
}

export function PullPublishCard({
  item,
  context,
  className,
}: {
  item: Extract<FeedItem, { kind: 'question' }>
  context: PullPublishCardContext
  className?: string
}) {
  const host = useShuttleHost()
  const identity = context.identities.get(item.threadId)

  const [title, setTitle] = useState(jsonText(item.defaults?.title) ?? '')
  const [body, setBody] = useState(jsonText(item.defaults?.body) ?? '')
  const existing = existingPull(item)

  const decide = useMutation({
    mutationFn: (actionId: 'draft' | 'publish' | 'update' | 'discard') =>
      actionId === 'discard'
        ? decideStructuredApproval(host, context.runId, item.approvalId, {
            actionId: 'discard',
            outcome: 'reject',
          })
        : decideStructuredApproval(host, context.runId, item.approvalId, {
            actionId,
            outcome: 'approve',
            payload: {
              title: title.trim() === '' ? 'Shuttle changes' : title.trim(),
              body,
              draft: actionId === 'update' ? (existing?.draft ?? true) : actionId === 'draft',
            },
          }),
  })

  // Once the session has the decision the card stays locked: the feed replaces it with the outcome.
  const pending = decide.isPending || decide.isSuccess
  const error = decide.error?.message
  const parentLabel = jsonText(item.defaults?.parentPullLabel)
  const restackLabel = jsonText(item.defaults?.restackLabel)

  return (
    <div className={cn('flex gap-3', className)} data-approval-id={item.approvalId}>
      <AgentAvatar identity={identity} threadId={item.threadId} />
      <div
        className={cn(
          'min-w-0 flex-1 rounded-xl border p-3',
          item.decision ? 'bg-card/40' : 'border-brand/30 bg-brand/6',
        )}
      >
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
          <GitPullRequest
            className={cn(
              'size-3.5 shrink-0',
              !item.decision && 'text-brand',
              item.publish?.status === 'published' && 'text-status-completed',
            )}
          />
          <span className="text-foreground/90 font-medium whitespace-nowrap">
            {publishHeading(item)}
          </span>
          <span className="message-time shrink-0 whitespace-nowrap tabular-nums">
            {clockTime(item.ts)}
          </span>
          {item.decision ? null : (
            <span className="text-brand ml-auto shrink-0">Needs approval</span>
          )}
        </div>
        {item.decision ? (
          <PublishOutcome
            item={item}
            agentLabel={identity?.label ?? 'this agent'}
            onInspect={() => context.onInspect(item.threadId, item.seq)}
          />
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {existing !== null ? (
              <p className="text-muted-foreground text-[11px]">
                Pushes this layer’s changes to{' '}
                {existing.url !== null ? (
                  <a
                    href={existing.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-foreground/90 font-mono underline-offset-2 hover:underline"
                  >
                    {existing.label}
                  </a>
                ) : (
                  <span className="text-foreground/90 font-mono">{existing.label}</span>
                )}
                {existing.draft ? ', which stays a draft' : ''}, and replaces its title and
                description with these.
              </p>
            ) : null}
            {parentLabel !== undefined && parentLabel !== '' ? (
              <p className="text-muted-foreground text-[11px]">
                Stacks on <span className="text-foreground/90 font-mono">{parentLabel}</span>
              </p>
            ) : null}
            {restackLabel !== undefined && restackLabel !== '' ? (
              <p className="text-muted-foreground text-[11px]">
                Will force-update{' '}
                <span className="text-foreground/90 font-mono">{restackLabel}</span>
              </p>
            ) : null}
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              disabled={context.readOnly || pending}
              className="border-input bg-background text-foreground h-9 rounded-md border px-3 text-[13px]"
              placeholder="Pull request title"
            />
            <Textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              disabled={context.readOnly || pending}
              placeholder="Summary, testing, risks…"
              className="min-h-24 resize-none text-[13px]"
            />
            <div className="flex flex-wrap items-center justify-end gap-2">
              {error !== undefined && error !== '' ? (
                <span className="text-status-failed mr-auto min-w-0 text-xs break-words">
                  {error}
                </span>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={context.readOnly || pending}
                onClick={() => decide.mutate('discard')}
              >
                Discard
              </Button>
              {existing !== null ? (
                <Button
                  type="button"
                  variant="brand"
                  size="sm"
                  disabled={context.readOnly || pending}
                  onClick={() => decide.mutate('update')}
                >
                  Push update
                </Button>
              ) : (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={context.readOnly || pending}
                    onClick={() => decide.mutate('draft')}
                  >
                    Publish as draft
                  </Button>
                  <Button
                    type="button"
                    variant="brand"
                    size="sm"
                    disabled={context.readOnly || pending}
                    onClick={() => decide.mutate('publish')}
                  >
                    Publish
                  </Button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** The pull request this card would push to, when the layer already has one. */
function existingPull(
  item: Extract<FeedItem, { kind: 'question' }>,
): { label: string; url: string | null; draft: boolean } | null {
  const label = jsonText(item.defaults?.existingPullLabel)

  return label !== undefined && label !== ''
    ? {
        label,
        url: jsonText(item.defaults?.existingPullUrl) ?? null,
        draft: item.defaults?.existingPullDraft === true,
      }
    : null
}

function publishHeading(item: Extract<FeedItem, { kind: 'question' }>): string {
  const existing = existingPull(item)

  if (!item.decision) {
    return existing !== null ? `Update ${existing.label}` : 'Publish pull requests'
  }

  if (item.decision.answer === null) {
    return existing !== null ? 'Update discarded' : 'Pull requests discarded'
  }

  if (!item.publish) {
    return existing !== null ? 'Update approved' : 'Publish approved'
  }

  switch (item.publish.status) {
    case 'published':
      return publishedHeading(item.publish.pulls)

    case 'failed':
      return existing !== null
        ? `Couldn’t update ${existing.label}`
        : 'Couldn’t publish pull requests'

    default: {
      const exhaustive: never = item.publish
      return exhaustive
    }
  }
}

function pullCount(n: number): string {
  return `${n} pull request${n === 1 ? '' : 's'}`
}

function publishedHeading(pulls: readonly PublishedPull[]): string {
  const opened = pulls.filter((pull) => pull.outcome !== 'updated' && pull.outcome !== 'unchanged')
  const updated = pulls.filter((pull) => pull.outcome === 'updated')

  if (opened.length > 0 && updated.length > 0) {
    return `Opened ${pullCount(opened.length)}, updated ${pullCount(updated.length)}`
  }

  if (opened.length > 0) {
    return `Opened ${pullCount(opened.length)}`
  }

  if (updated.length > 0) {
    return updated.length === 1
      ? `Updated #${updated[0]?.number}`
      : `Updated ${pullCount(updated.length)}`
  }

  return 'Pull requests already up to date'
}

/** Publishing commits and opens PRs in a few seconds; minutes of silence means no result is coming. */
const PUBLISH_STALE_MS = 5 * 60_000

function PublishPending({
  item,
  decidedAt,
}: {
  item: Extract<FeedItem, { kind: 'question' }>
  decidedAt: number
}) {
  const now = useNow(15_000)

  if (now - decidedAt > PUBLISH_STALE_MS) {
    return (
      <p className="text-muted-foreground mt-2 text-xs">
        No publish result was recorded. Ask the conductor to propose the pull request again.
      </p>
    )
  }

  return (
    <p className="text-muted-foreground mt-2 flex items-center gap-1.5 text-xs">
      <LoaderCircle className="size-3 animate-spin" />
      {existingPull(item) !== null
        ? 'Pushing changes…'
        : 'Committing changes and opening pull requests…'}
    </p>
  )
}

function PublishOutcome({
  item,
  agentLabel,
  onInspect,
}: {
  item: Extract<FeedItem, { kind: 'question' }>
  agentLabel: string
  onInspect: () => void
}) {
  if (item.decision?.answer === null) {
    return <p className="text-muted-foreground mt-2 text-xs">Nothing was pushed.</p>
  }

  if (!item.publish) {
    return <PublishPending item={item} decidedAt={item.decision?.ts ?? item.ts} />
  }

  if (item.publish.status === 'failed') {
    return <p className="text-status-failed mt-2 text-xs break-words">{item.publish.error}</p>
  }

  return (
    <div className="mt-2 flex flex-col gap-1">
      <ul className="-mx-1 flex flex-col">
        {item.publish.pulls.map((pull) => (
          <li key={`${pull.fullName}#${pull.number}`}>
            <a
              href={pull.url}
              target="_blank"
              rel="noreferrer"
              className="hover:bg-accent/50 group flex h-8 min-w-0 items-center gap-2 rounded-md px-1 text-[13px] transition-colors duration-100"
            >
              <span className="text-muted-foreground truncate">{pull.fullName}</span>
              <span className="text-foreground shrink-0 font-mono">#{pull.number}</span>
              {pull.draft ? (
                <span className="text-muted-foreground shrink-0 rounded border border-dashed px-1 text-[10px] uppercase">
                  Draft
                </span>
              ) : null}
              <ExternalLink className="text-muted-foreground ml-auto size-3 shrink-0 opacity-0 transition-opacity duration-100 group-hover:opacity-100" />
            </a>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground text-[11px]">
        {item.publish.pulls.every((pull) => pull.outcome === 'updated') ? 'Updated' : 'Opened'} by{' '}
        <button
          type="button"
          onClick={onInspect}
          className="hover:text-foreground underline-offset-2 hover:underline"
        >
          {agentLabel}
        </button>
        . The folder’s pull request inbox links back here.
      </p>
    </div>
  )
}

function AgentAvatar({ identity, threadId }: { identity?: AgentIdentity; threadId: string }) {
  const role = identity?.role ?? agentRole(undefined)
  const Icon = role.icon

  return (
    <span
      className={cn(
        'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-current/10 ring-1 ring-current/15 ring-inset',
        role.tone,
      )}
      title={threadId}
    >
      <Icon className="size-3.5" />
    </span>
  )
}

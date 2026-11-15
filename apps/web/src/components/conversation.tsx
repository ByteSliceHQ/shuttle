import { Link } from '@tanstack/react-router'
import {
  ArrowRight,
  Check,
  CircleStop,
  ChevronRight,
  CornerDownRight,
  FileDiff,
  GitPullRequest,
  Globe,
  LoaderCircle,
  MessageCircleQuestion,
  MessageSquareDashed,
  Shuffle,
  Sparkles,
  TriangleAlert,
  X,
} from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { StatusDot } from '@/components/status-dot'
import type { AgentIdentity } from '@/lib/agents'
import { agentRole } from '@/lib/agents'
import { answerQuestion, decideStructuredApproval, reroute, stopSession } from '@/lib/api'
import { changedPaths, previewPorts } from '@/lib/artifact-links'
import { cn, compactJson, errorMessage } from '@/lib/cn'
import { classifyHeuristic } from '@/lib/intake-heuristic'
import { jsonFields, jsonText } from '@/lib/json'
import { provisionalRouteSummary, routeStyles } from '@/lib/routes'
import {
  deriveRouteWaitFallback,
  resolveThreadActivityTone,
  type RouteWaitFallback,
  type SessionActivityState,
} from '@/lib/session-activity'
import {
  interjectionKinds,
  type FeedItem,
  type InterjectionKind,
  type RouteDelivery,
  type RouteInfo,
  type SessionFeed,
  type StreamingTurn,
  type ThoughtInfo,
  type ToolCallItem,
} from '@/lib/session-feed'
import { statusClass, statusLabel } from '@/lib/status'
import { useTenant } from '@/lib/tenant'
import { clockTime } from '@/lib/time'
import {
  projectTimeline,
  repeatedMessages,
  threadParents,
  threadSpeaks,
  type DelegationRow,
  type TimelineRow,
} from '@/lib/timeline'
import { useNow } from '@/lib/use-now'
import type { ThreadNode } from '@swirls/looms/core'

import { FollowList } from './follow-list'
import { Markdown } from './markdown'
import { MediaStrip } from './media'
import { PullPublishCard } from './pull-publish-card'
import { Button } from './ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { EmptyState } from './ui/panel'
import { Textarea } from './ui/textarea'

type Row =
  | TimelineRow
  | {
      readonly kind: 'stream'
      readonly id: string
      readonly threadId: string
      readonly turn: number
      readonly text: string
      readonly thinking: string
      readonly thinkingStartedAt?: number
      readonly thinkingEndedAt?: number
    }

/** Shows something in the artifacts pane, such as the workspace or a preview by port. */
export type OpenArtifact = (
  kind: 'files' | 'browser' | 'terminal' | 'review' | 'media',
  target?: string,
) => void

interface ConversationContext {
  readonly runId: string
  readonly feed: SessionFeed
  readonly activity: SessionActivityState
  readonly identities: ReadonlyMap<string, AgentIdentity>
  readonly onInspect: (threadId: string, seq?: number) => void
  readonly onOpenArtifact?: OpenArtifact
  /** Opens an agent's own timeline. */
  readonly onOpenThread: (threadId: string) => void
  readonly threadNodes: ReadonlyMap<string, ThreadNode>
  /** Agent messages that repeat an earlier one, which fold to a line. */
  readonly repeats: ReadonlySet<string>
  readonly thoughtOpen: ReadonlyMap<string, boolean>
  readonly setThoughtOpen: (key: string, open: boolean) => void
  readonly liveByToolCardId: ReadonlyMap<string, StreamingTurn>
  readonly inlineNarratorByMessageId: ReadonlyMap<
    string,
    readonly Extract<FeedItem, { kind: 'agent' }>[]
  >
  readonly streaming: Readonly<Record<string, StreamingTurn>>
}

function thoughtKey(threadId: string, turn: number): string {
  return `${threadId}:${turn}`
}

function formatSeconds(durationMs: number): string {
  if (durationMs >= 60_000) {
    const minutes = Math.floor(durationMs / 60_000)
    const seconds = Math.round((durationMs % 60_000) / 1000)
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
  }

  if (durationMs >= 10_000) {
    return `${Math.round(durationMs / 1000)}s`
  }

  const fixed = Math.max(0.1, durationMs / 1000).toFixed(1)
  return fixed.endsWith('.0') ? `${fixed.slice(0, -2)}s` : `${fixed}s`
}

function formatThoughtLabel(durationMs: number | undefined): string {
  return durationMs !== undefined ? `Thought for ${formatSeconds(durationMs)}` : 'Thought'
}

function cleanSnippet(line: string): string {
  return line
    .replace(/^[\s>#*-]+/, '')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function latestThoughtLine(text: string): string {
  const lines = text.split('\n')

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const cleaned = cleanSnippet(lines[index] ?? '')

    if (cleaned) {
      return cleaned
    }
  }

  return ''
}

function rowSpeakerThreadId(row: Row | undefined): string | undefined {
  if (!row) {
    return undefined
  }

  switch (row.kind) {
    case 'agent':
    case 'thought':
    case 'tools':
    case 'question':
    case 'media':
    case 'stream':
      return row.threadId
    case 'user':
    case 'notice':
    case 'delegation':
      return undefined

    default: {
      const exhaustive: never = row
      return exhaustive
    }
  }
}

export function Conversation({
  runId,
  feed,
  activity,
  streaming,
  identities,
  onInspect,
  onOpenArtifact,
  root,
  openThreadId,
  onOpenThread,
}: {
  runId: string
  feed: SessionFeed
  activity: SessionActivityState
  streaming: Readonly<Record<string, StreamingTurn>>
  identities: ReadonlyMap<string, AgentIdentity>
  onInspect: (threadId: string, seq?: number) => void
  /** Left out, messages carry no links into the artifacts pane. */
  onOpenArtifact?: OpenArtifact
  /** The session's threads, which decide what the timeline folds away. */
  root: ThreadNode | null
  /** The agent whose own timeline is open. Left out, it is the session's top level. */
  openThreadId?: string
  onOpenThread: (threadId: string) => void
}) {
  const { parents, threadNodes } = useMemo(() => {
    const nodes = new Map<string, ThreadNode>()

    function visit(node: ThreadNode) {
      nodes.set(node.threadId, node)
      node.children.forEach(visit)
    }

    if (root) {
      visit(root)
    }

    return { parents: threadParents(root), threadNodes: nodes }
  }, [root])

  const { rows, liveByToolCardId, inlineNarratorByMessageId } = useMemo(() => {
    let lastUserIndex = -1

    for (let index = feed.items.length - 1; index >= 0; index -= 1) {
      if (feed.items[index]?.kind === 'user') {
        lastUserIndex = index
        break
      }
    }

    const latestThreadItem = new Map<string, FeedItem>()

    for (let index = lastUserIndex + 1; index < feed.items.length; index += 1) {
      const item = feed.items[index]

      if (
        item &&
        (item.kind === 'agent' ||
          item.kind === 'tools' ||
          item.kind === 'question' ||
          item.kind === 'thought')
      ) {
        latestThreadItem.set(item.threadId, item)
      }
    }

    const attached = new Map<string, StreamingTurn>()
    const liveRows: Row[] = []

    for (const [threadId, turn] of Object.entries(streaming)) {
      // A thread that is folded away or outside this view has no bubble of its own.
      if (feed.narrators[threadId] || !threadSpeaks(threadId, parents, openThreadId)) {
        continue
      }

      const hasThinking = turn.thinking.trim().length > 0
      const hasText = turn.text.trim().length > 0

      if (!hasThinking && !hasText) {
        continue
      }

      const latest = latestThreadItem.get(threadId)

      // Keep between-tool thinking inside the agent's active tool card instead of popping a temporary bubble.
      if (!hasText && latest?.kind === 'tools') {
        attached.set(latest.id, turn)
        continue
      }

      liveRows.push({
        kind: 'stream',
        id: `stream_${threadId}`,
        threadId,
        turn: turn.turn,
        text: turn.text,
        thinking: turn.thinking,
        thinkingStartedAt: turn.thinkingStartedAt,
        thinkingEndedAt: turn.thinkingEndedAt,
      })
    }

    const narratorRepliesByMessageId = new Map<string, Extract<FeedItem, { kind: 'agent' }>[]>()

    for (const item of feed.items) {
      if (item.kind === 'agent' && item.replyTo) {
        const list = narratorRepliesByMessageId.get(item.replyTo) ?? []
        list.push(item)
        narratorRepliesByMessageId.set(item.replyTo, list)
      }
    }

    // At the top level a narrator's reply sits under the message it answers. Inside the
    // narrator's own thread there is no such message, so it shows in the timeline.
    const visibleItems =
      openThreadId === undefined
        ? feed.items.filter((item) => !(item.kind === 'agent' && item.replyTo !== undefined))
        : feed.items

    // A message waiting for an agent to finish its turn sits below that turn's live work.
    const waiting = (item: FeedItem) => item.kind === 'user' && item.messageId in feed.queued

    return {
      rows: [
        ...projectTimeline(
          visibleItems.filter((item) => !waiting(item)),
          parents,
          openThreadId,
        ),
        ...liveRows,
        ...(openThreadId === undefined ? visibleItems.filter(waiting) : []),
      ],
      liveByToolCardId: attached,
      inlineNarratorByMessageId: narratorRepliesByMessageId,
    }
  }, [feed.items, feed.narrators, feed.queued, streaming, parents, openThreadId])

  const repeats = useMemo(() => repeatedMessages(feed.items), [feed.items])

  // History replayed on load renders still; live arrivals settle in once, even if virtualization remounts them.
  const [mountedAt] = useState(() => Date.now())
  const animated = useRef(new Set<string>())
  const [thoughtOpen, setThoughtOpenState] = useState(() => new Map<string, boolean>())

  const setThoughtOpen = useCallback((key: string, open: boolean) => {
    setThoughtOpenState((prev) => {
      if (prev.get(key) === open) {
        return prev
      }

      const next = new Map(prev)
      next.set(key, open)
      return next
    })
  }, [])

  const onSettled = useCallback((id: string) => {
    animated.current.add(id)
  }, [])

  const context = useMemo<ConversationContext>(
    () => ({
      runId,
      feed,
      activity,
      identities,
      onInspect,
      onOpenArtifact,
      onOpenThread,
      threadNodes,
      repeats,
      thoughtOpen,
      setThoughtOpen,
      liveByToolCardId,
      inlineNarratorByMessageId,
      streaming,
    }),
    [
      runId,
      feed,
      activity,
      identities,
      onInspect,
      onOpenArtifact,
      onOpenThread,
      threadNodes,
      repeats,
      thoughtOpen,
      setThoughtOpen,
      liveByToolCardId,
      inlineNarratorByMessageId,
      streaming,
    ],
  )

  return (
    <FollowList
      // A different thread is a different timeline: start it at its latest, not mid-scroll.
      key={openThreadId ?? 'session'}
      items={rows}
      getKey={(row) => row.id}
      estimateSize={72}
      overscan={6}
      paddingStart={16}
      paddingEnd={28}
      viewportClassName="conversation-fade"
      itemClassName="px-4 sm:px-6"
      empty={
        openThreadId === undefined ? (
          <EmptyState icon={<MessageSquareDashed />} title="Connecting to the session">
            Events stream in from the Durable Object as soon as the run starts.
          </EmptyState>
        ) : (
          <EmptyState icon={<MessageSquareDashed />} title="Nothing here yet">
            This agent has not said or done anything so far.
          </EmptyState>
        )
      }
      renderItem={(row, index) => {
        const previousThreadId = rowSpeakerThreadId(index > 0 ? rows[index - 1] : undefined)

        return (
          <div className="message-row mx-auto w-full max-w-3xl py-1.5">
            <RowView
              row={row}
              previousThreadId={previousThreadId}
              context={context}
              animate={('ts' in row ? row.ts >= mountedAt : true) && !animated.current.has(row.id)}
              onSettled={onSettled}
            />
          </div>
        )
      }}
    />
  )
}

const RowView = memo(function RowView({
  row,
  previousThreadId,
  context,
  animate,
  onSettled,
}: {
  row: Row
  previousThreadId: string | undefined
  context: ConversationContext
  animate: boolean
  onSettled: (id: string) => void
}) {
  // Keep the first decision for this mount so a re-render never cuts the entrance short.
  const [entering] = useState(animate)

  useEffect(() => {
    onSettled(row.id)
  }, [onSettled, row.id])

  const className = entering ? 'rise-in' : undefined

  switch (row.kind) {
    case 'user':
      return (
        <UserMessage
          className={className}
          item={row}
          context={context}
          route={context.feed.routes[row.messageId]}
          deliveries={context.feed.deliveries[row.messageId] ?? []}
          classifying={Boolean(context.feed.classifying[row.messageId])}
        />
      )
    case 'agent':
      return <AgentMessage className={className} item={row} context={context} />
    case 'thought':
      return (
        <ThoughtWhisper
          className={className}
          item={row}
          showIdentity={previousThreadId !== row.threadId}
          context={context}
        />
      )
    case 'tools':
      return (
        <ToolActivity
          className={className}
          item={row}
          showIdentity={previousThreadId !== row.threadId}
          context={context}
        />
      )
    case 'question':
      return <QuestionCard className={className} item={row} context={context} />
    case 'notice':
      return <Notice className={className} item={row} context={context} />
    case 'media':
      return (
        <SharedMedia
          className={className}
          item={row}
          showIdentity={previousThreadId !== row.threadId}
          context={context}
        />
      )
    case 'delegation':
      return <DelegationCard className={className} row={row} context={context} />
    case 'stream':
      return (
        <AgentBubble
          className={className}
          identity={context.identities.get(row.threadId)}
          threadId={row.threadId}
          turn={row.turn}
          text={row.text}
          thinking={row.thinking}
          thinkingStartedAt={row.thinkingStartedAt}
          thinkingEndedAt={row.thinkingEndedAt}
          streaming
          context={context}
          onInspect={context.onInspect}
        />
      )

    default: {
      const exhaustive: never = row
      return exhaustive
    }
  }
})

function humanize(text: string, identities: ReadonlyMap<string, AgentIdentity>): string {
  let result = text

  for (const identity of identities.values()) {
    result = result.replaceAll(identity.threadId, identity.label)
  }

  return result
}

function UserMessage({
  item,
  route,
  deliveries,
  classifying,
  context,
  className,
}: {
  item: Extract<FeedItem, { kind: 'user' }>
  route: RouteInfo | undefined
  deliveries: readonly RouteDelivery[]
  classifying: boolean
  context: ConversationContext
  className?: string
}) {
  const me = useTenant().user.id

  return (
    <div className={cn('group/user flex w-full flex-col gap-1.5', className)}>
      <div className="flex flex-col items-end gap-1.5">
        <div className="text-muted-foreground flex items-center gap-2 pr-1 text-[11px]">
          <span className="text-foreground/80 font-medium">
            {item.goal ? 'Goal' : item.author && item.author.id !== me ? item.author.name : 'You'}
          </span>
          <span className="message-time tabular-nums">{clockTime(item.ts)}</span>
        </div>
        {item.text ? (
          <div
            className={cn(
              'max-w-[85%] rounded-2xl rounded-tr-md px-3.5 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap',
              item.goal
                ? 'bg-brand/12 text-foreground ring-brand/25 ring-1 ring-inset'
                : 'bg-secondary text-secondary-foreground',
            )}
          >
            {item.text}
          </div>
        ) : null}
        {item.attachments ? (
          <MediaStrip
            runId={context.runId}
            assets={item.attachments}
            align="end"
            className="max-w-[85%]"
          />
        ) : null}
        {item.goal ? null : (
          <RouteChip
            runId={context.runId}
            messageId={item.messageId}
            messageTs={item.ts}
            text={item.text}
            route={route}
            deliveries={deliveries}
            classifying={classifying}
            forcedKind={item.forced}
            identities={context.identities}
            context={context}
            onInspect={context.onInspect}
          />
        )}
      </div>
      {!item.goal ? <InlineNarratorReplies messageId={item.messageId} context={context} /> : null}
    </div>
  )
}

function InlineNarratorReplies({
  messageId,
  context,
}: {
  messageId: string
  context: ConversationContext
}) {
  const narratorThreadId = context.feed.narratorFor[messageId]
  const settled = context.inlineNarratorByMessageId.get(messageId) ?? []
  const streamTurn = narratorThreadId ? context.streaming[narratorThreadId] : undefined

  const hasStream =
    streamTurn !== undefined &&
    (streamTurn.thinking.trim().length > 0 || streamTurn.text.trim().length > 0)

  if (settled.length === 0 && !hasStream) {
    return null
  }

  return (
    // No indent: every agent avatar in the conversation sits on the same left edge.
    <div className="mt-1 w-full space-y-2">
      {settled.map((item) => (
        <AgentBubble
          key={item.id}
          identity={context.identities.get(item.threadId)}
          threadId={item.threadId}
          turn={item.thought?.turn}
          text={item.text}
          thought={item.thought}
          ts={item.ts}
          seq={item.seq}
          repeat={context.repeats.has(item.id)}
          context={context}
          onInspect={context.onInspect}
        />
      ))}
      {hasStream && narratorThreadId && streamTurn ? (
        <AgentBubble
          identity={context.identities.get(narratorThreadId)}
          threadId={narratorThreadId}
          turn={streamTurn.turn}
          text={streamTurn.text}
          thinking={streamTurn.thinking}
          thinkingStartedAt={streamTurn.thinkingStartedAt}
          thinkingEndedAt={streamTurn.thinkingEndedAt}
          streaming
          context={context}
          onInspect={context.onInspect}
        />
      ) : null}
    </div>
  )
}

function RouteWaitFallbackRow({
  runId,
  wait,
  identities,
  onInspect,
}: {
  runId: string
  wait: RouteWaitFallback
  identities: ReadonlyMap<string, AgentIdentity>
  onInspect: (threadId: string, seq?: number) => void
}) {
  const [pending, setPending] = useState(false)
  const label = identities.get(wait.threadId)?.label ?? 'worker'

  return (
    <span className="text-muted-foreground inline-flex max-w-full flex-wrap items-center justify-end gap-2 pr-1 text-[11px]">
      <button
        type="button"
        onClick={() => onInspect(wait.threadId)}
        className="hover:text-foreground text-left"
      >
        Waiting for {label} to finish{' '}
        <span className="text-foreground/90 font-mono">{wait.toolName}</span>
        <span className="tabular-nums"> · {formatSeconds(wait.elapsedMs)}</span>
      </button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        className="h-6 gap-1 px-2 text-[11px]"
        onClick={() => {
          setPending(true)
          void stopSession(runId, wait.threadId).finally(() => setPending(false))
        }}
      >
        {pending ? (
          <LoaderCircle className="size-3 animate-spin" />
        ) : (
          <CircleStop className="size-3" />
        )}
        Stop
      </Button>
    </span>
  )
}

/** Owns the 1s clock so only unrouted messages re-render while waiting. */
function PendingRouteChip({
  runId,
  messageTs,
  text,
  classifying,
  forcedKind,
  identities,
  context,
  onInspect,
}: {
  runId: string
  messageTs: number
  text: string
  classifying: boolean
  forcedKind?: InterjectionKind
  identities: ReadonlyMap<string, AgentIdentity>
  context: ConversationContext
  onInspect: (threadId: string, seq?: number) => void
}) {
  const now = useNow(1_000)

  const waitFallback = deriveRouteWaitFallback({
    messageTs,
    hasRoute: false,
    now,
    activity: context.activity,
    feed: context.feed,
  })

  const provisionalKind = forcedKind ?? classifyHeuristic(text)
  const style = routeStyles[provisionalKind]
  const Icon = style.icon

  return (
    <div className="flex max-w-[85%] flex-col items-end gap-1.5">
      <span
        className={cn(
          'inline-flex h-6 items-center gap-1.5 rounded-full bg-current/10 px-2 text-[11px] font-medium ring-1 ring-current/15 ring-inset',
          style.tone,
        )}
        title={style.description}
      >
        {classifying ? (
          <LoaderCircle className="size-3 animate-spin" />
        ) : (
          <Icon className="size-3" />
        )}
        <span>
          {style.label}
          <span className="opacity-70"> · {provisionalRouteSummary(provisionalKind)}</span>
        </span>
      </span>
      {waitFallback ? (
        <RouteWaitFallbackRow
          runId={runId}
          wait={waitFallback}
          identities={identities}
          onInspect={onInspect}
        />
      ) : null}
    </div>
  )
}

function RunningElapsed({ startedAt }: { startedAt: number }) {
  const now = useNow(1_000)

  return (
    <span className="text-status-running ml-auto shrink-0 tabular-nums">
      {formatSeconds(Math.max(0, now - startedAt))}
    </span>
  )
}

function RouteChip({
  runId,
  messageId,
  messageTs,
  text,
  route,
  deliveries,
  classifying,
  forcedKind,
  identities,
  context,
  onInspect,
}: {
  runId: string
  messageId: string
  messageTs: number
  text: string
  route: RouteInfo | undefined
  deliveries: readonly RouteDelivery[]
  classifying: boolean
  forcedKind?: InterjectionKind
  identities: ReadonlyMap<string, AgentIdentity>
  context: ConversationContext
  onInspect: (threadId: string, seq?: number) => void
}) {
  if (!route) {
    return (
      <PendingRouteChip
        runId={runId}
        messageTs={messageTs}
        text={text}
        classifying={classifying}
        forcedKind={forcedKind}
        identities={identities}
        context={context}
        onInspect={onInspect}
      />
    )
  }

  const style = routeStyles[route.kind]
  const Icon = style.icon
  const targets = [...new Map(deliveries.map((entry) => [entry.threadId, entry])).values()]
  const forced = forcedKind !== undefined

  return (
    <div className="flex max-w-[85%] flex-wrap items-center justify-end gap-1.5 text-[11px]">
      <span
        className={cn(
          'inline-flex h-6 items-center gap-1.5 rounded-full bg-current/10 px-2 font-medium ring-1 ring-current/15 ring-inset',
          style.tone,
        )}
        title={style.description}
      >
        <Icon className="size-3" />
        {style.label}
        {forced ? <span className="opacity-60">· forced</span> : null}
      </span>
      {targets.length > 0 ? (
        targets.map((delivery) => {
          const identity = identities.get(delivery.threadId)
          const label = identity?.label ?? 'agent'
          const waiting = context.feed.queued[messageId] === delivery.threadId

          return (
            <button
              key={delivery.threadId}
              type="button"
              onClick={() => onInspect(delivery.threadId)}
              className="text-muted-foreground hover:text-foreground hover:bg-accent inline-flex h-6 items-center gap-1 rounded-full border px-2 transition-colors duration-100"
              title={
                delivery.interrupt
                  ? 'Interrupted the current turn'
                  : waiting
                    ? `${label} reads this when it finishes its current turn`
                    : 'Queued for the next step'
              }
            >
              <ArrowRight className="size-3" />
              {label}
              {delivery.interrupt ? (
                <span className="text-route-correction font-medium">interrupt</span>
              ) : waiting ? (
                <span className="opacity-70">· after this turn</span>
              ) : null}
            </button>
          )
        })
      ) : (
        <span className="text-muted-foreground px-1">{humanize(route.summary, identities)}</span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Reroute message"
            className="text-muted-foreground hover:text-foreground hover:bg-accent data-[state=open]:bg-accent flex size-6 items-center justify-center rounded-full opacity-0 transition-opacity duration-150 group-hover/user:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
          >
            <Shuffle className="size-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Reroute as…</DropdownMenuLabel>
          {interjectionKinds
            .filter((kind) => kind !== route.kind)
            .map((kind) => (
              <DropdownMenuItem key={kind} onSelect={() => void reroute(runId, messageId, kind)}>
                <span className={cn('size-1.5 rounded-full', routeStyles[kind].dot)} />
                {routeStyles[kind].label}
                <span className="text-muted-foreground ml-auto pl-3 text-[11px]">
                  {routeStyles[kind].description}
                </span>
              </DropdownMenuItem>
            ))}
        </DropdownMenuContent>
      </DropdownMenu>
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

function ThinkingTrace({
  text,
  durationMs,
  activelyThinking,
  open,
  onToggle,
}: {
  text: string
  durationMs?: number
  activelyThinking: boolean
  open: boolean
  onToggle: () => void
}) {
  const label = activelyThinking ? 'Thinking…' : formatThoughtLabel(durationMs)
  const liveSnippet = activelyThinking && !open ? latestThoughtLine(text) : ''

  return (
    <div className="mt-1 min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="text-muted-foreground/80 hover:text-foreground inline-flex max-w-full min-w-0 items-center gap-1 text-left text-[11.5px] transition-colors duration-100"
      >
        <ChevronRight
          className={cn(
            'ease-snappy size-3 shrink-0 transition-transform duration-150',
            open && 'rotate-90',
          )}
        />
        <span
          className={cn(
            'shrink-0 whitespace-nowrap tabular-nums',
            activelyThinking && 'text-status-running breathe',
          )}
        >
          {label}
        </span>
        {liveSnippet ? (
          <span className="text-muted-foreground/65 min-w-0 truncate pl-1">{liveSnippet}</span>
        ) : null}
      </button>
      {open ? (
        <div className="thinking-trace-body border-border/80 mt-1.5 mb-1 max-h-52 overflow-y-auto border-l py-0.5 pl-3">
          <Markdown text={text} className="text-muted-foreground text-[12.5px] leading-relaxed" />
        </div>
      ) : null}
    </div>
  )
}

function AgentBubble({
  identity,
  threadId,
  turn,
  text,
  thinking,
  thought,
  thinkingStartedAt,
  thinkingEndedAt,
  ts,
  seq,
  replyTo,
  streaming = false,
  repeat = false,
  context,
  onInspect,
  className,
}: {
  identity?: AgentIdentity
  threadId: string
  turn?: number
  text: string
  thinking?: string
  thought?: ThoughtInfo
  thinkingStartedAt?: number
  thinkingEndedAt?: number
  ts?: number
  seq?: number
  replyTo?: string
  streaming?: boolean
  /** Says what an earlier message already said, so it starts folded to one line. */
  repeat?: boolean
  context?: ConversationContext
  onInspect: (threadId: string, seq?: number) => void
  className?: string
}) {
  const thinkingText = (thinking ?? thought?.text ?? '').trim()
  const replyText = text.trim()
  const activelyThinking = streaming && thinkingText.length > 0 && replyText.length === 0
  const status = streaming && replyText.length > 0 ? 'typing' : null

  const durationMs =
    thought?.durationMs ??
    (thinkingStartedAt !== undefined && thinkingEndedAt !== undefined
      ? Math.max(0, thinkingEndedAt - thinkingStartedAt)
      : undefined)

  const key =
    turn !== undefined
      ? thoughtKey(threadId, turn)
      : thought
        ? thoughtKey(threadId, thought.turn)
        : null

  const open = key && context ? Boolean(context.thoughtOpen.get(key)) : false
  // A finished thought of a second or so is routine, and is left out.
  const [repeatShown, setRepeatShown] = useState(false)
  const folded = repeat && !repeatShown
  const briefThought = !activelyThinking && durationMs !== undefined && durationMs < 2000

  return (
    <div className={cn('flex gap-3', className)}>
      <AgentAvatar identity={identity} threadId={threadId} />
      <div className="min-w-0 flex-1">
        <div className="text-muted-foreground flex items-center gap-2 text-[11px]">
          <button
            type="button"
            onClick={() => onInspect(threadId, seq)}
            className="text-foreground/90 hover:text-foreground shrink-0 font-medium whitespace-nowrap hover:underline"
          >
            {identity?.label ?? 'Agent'}
          </button>
          {ts !== undefined ? (
            <span className="message-time shrink-0 whitespace-nowrap tabular-nums">
              {clockTime(ts)}
            </span>
          ) : null}
          {status ? (
            <span className="text-status-running shrink-0 whitespace-nowrap">{status}</span>
          ) : null}
        </div>
        {folded ? (
          <button
            type="button"
            onClick={() => setRepeatShown(true)}
            aria-expanded={false}
            className="text-muted-foreground/80 hover:text-foreground mt-1 inline-flex max-w-full items-center gap-1 text-left text-[12.5px] transition-colors duration-100"
          >
            <ChevronRight className="size-3 shrink-0" />
            <span className="truncate">Same reply as before</span>
          </button>
        ) : null}
        {replyTo && !folded ? (
          <p className="text-muted-foreground mt-1 flex items-center gap-1 truncate text-[11px]">
            <CornerDownRight className="size-3 shrink-0" />
            <span className="truncate italic">{replyTo}</span>
          </p>
        ) : null}
        {thinkingText && key && context && !folded && !briefThought ? (
          <ThinkingTrace
            text={thinkingText}
            durationMs={activelyThinking ? undefined : durationMs}
            activelyThinking={activelyThinking}
            open={open}
            onToggle={() => context.setThoughtOpen(key, !open)}
          />
        ) : null}
        {replyText && !folded ? (
          <Markdown
            text={text}
            className={cn(
              'text-foreground/95 mt-1 text-[13.5px] leading-relaxed',
              streaming && 'caret',
            )}
          />
        ) : null}
        {replyText && !streaming && !folded && context?.onOpenArtifact ? (
          <PreviewLinks text={text ?? ''} onOpen={context.onOpenArtifact} />
        ) : null}
      </div>
    </div>
  )
}

/** A quiet button under a message that opens what the message is about in the artifacts pane. */
function ArtifactLink({
  icon,
  onOpen,
  children,
}: {
  icon: ReactNode
  onOpen: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="text-muted-foreground hover:text-foreground hover:bg-accent/60 bg-card/60 ease-snappy inline-flex h-7 max-w-full items-center gap-1.5 rounded-lg border px-2.5 text-[12px] transition-[background-color,color,transform] duration-150 active:scale-[0.97] [&_svg]:size-3.5 [&_svg]:shrink-0"
    >
      {icon}
      <span className="min-w-0 truncate">{children}</span>
      <ArrowRight className="opacity-60" />
    </button>
  )
}

/** Links to the previews a message says are running. */
function PreviewLinks({ text, onOpen }: { text: string; onOpen: OpenArtifact }) {
  const ports = useMemo(() => previewPorts(text), [text])

  if (ports.length === 0) {
    return null
  }

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {ports.map((port) => (
        <ArtifactLink key={port} icon={<Globe />} onOpen={() => onOpen('browser', port)}>
          Open preview on port <span className="tabular-nums">{port}</span>
        </ArtifactLink>
      ))}
    </div>
  )
}

function AgentMessage({
  item,
  context,
  className,
}: {
  item: Extract<FeedItem, { kind: 'agent' }>
  context: ConversationContext
  className?: string
}) {
  const replyTo = item.replyTo ? context.feed.messageText[item.replyTo] : undefined

  return (
    <AgentBubble
      className={className}
      identity={context.identities.get(item.threadId)}
      threadId={item.threadId}
      turn={item.thought?.turn}
      text={item.text}
      thought={item.thought}
      ts={item.ts}
      seq={item.seq}
      replyTo={replyTo}
      repeat={context.repeats.has(item.id)}
      context={context}
      onInspect={context.onInspect}
    />
  )
}

/** Files an agent shared, shown in the conversation under the agent's name. */
function SharedMedia({
  item,
  showIdentity,
  context,
  className,
}: {
  item: Extract<FeedItem, { kind: 'media' }>
  showIdentity: boolean
  context: ConversationContext
  className?: string
}) {
  const identity = context.identities.get(item.threadId)
  const count = item.assets.length

  return (
    <div className={cn('flex flex-col gap-1.5 pl-10', className)}>
      <div className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-[11.5px]">
        {showIdentity ? (
          <button
            type="button"
            onClick={() => context.onInspect(item.threadId, item.seq)}
            className={cn(
              'shrink-0 font-medium whitespace-nowrap hover:underline',
              identity?.role.tone,
            )}
          >
            {identity?.label ?? 'Agent'}
          </button>
        ) : null}
        <span>shared {count === 1 ? 'a file' : `${count} files`}</span>
        <span className="message-time tabular-nums">{clockTime(item.ts)}</span>
        {context.onOpenArtifact ? (
          <button
            type="button"
            onClick={() => context.onOpenArtifact?.('media')}
            className="hover:text-foreground ml-auto shrink-0 hover:underline"
          >
            All media
          </button>
        ) : null}
      </div>
      <MediaStrip runId={context.runId} assets={item.assets} />
    </div>
  )
}

/** Borderless fallback for the rare case where a turn settles with only a thought. */
function ThoughtWhisper({
  item,
  showIdentity,
  context,
  className,
}: {
  item: Extract<FeedItem, { kind: 'thought' }>
  showIdentity: boolean
  context: ConversationContext
  className?: string
}) {
  const identity = context.identities.get(item.threadId)
  const key = thoughtKey(item.threadId, item.turn)
  const open = Boolean(context.thoughtOpen.get(key))
  const label = formatThoughtLabel(item.durationMs)
  return (
    <div className={cn('pl-10', className)}>
      <div className="flex min-w-0 items-center gap-1.5 py-0.5 text-[11.5px]">
        {showIdentity ? (
          <>
            <button
              type="button"
              onClick={() => context.onInspect(item.threadId, item.seq)}
              className={cn(
                'shrink-0 font-medium whitespace-nowrap hover:underline',
                identity?.role.tone,
              )}
            >
              {identity?.label ?? 'Agent'}
            </button>
            <span className="text-muted-foreground/40 shrink-0 select-none">·</span>
          </>
        ) : null}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => context.setThoughtOpen(key, !open)}
          className="text-muted-foreground/80 hover:text-foreground inline-flex min-w-0 items-center gap-1 text-left transition-colors duration-100"
        >
          <ChevronRight
            className={cn(
              'ease-snappy size-3 shrink-0 transition-transform duration-150',
              open && 'rotate-90',
            )}
          />
          <span className="shrink-0 whitespace-nowrap tabular-nums">{label}</span>
        </button>
      </div>
      {open ? (
        <div className="thinking-trace-body border-border/80 mt-1 ml-1 max-h-52 overflow-y-auto border-l py-0.5 pl-3">
          <Markdown
            text={item.text}
            className="text-muted-foreground text-[12.5px] leading-relaxed"
          />
        </div>
      ) : null}
    </div>
  )
}

function toolArgsPreview(call: ToolCallItem): string {
  const fields = jsonFields(call.args)
  const primary = fields.path ?? fields.command ?? fields.pattern ?? fields.text ?? fields.goal

  return jsonText(primary) ?? compactJson(call.args, 80)
}

function ToolStatusIcon({ status }: { status: ToolCallItem['status'] }) {
  switch (status) {
    case 'running':
      return <LoaderCircle className="text-status-running size-3 shrink-0 animate-spin" />
    case 'ok':
      return <Check className="text-status-completed size-3 shrink-0" />
    case 'error':
      return <X className="text-status-failed size-3 shrink-0" />

    default: {
      const exhaustive: never = status
      return exhaustive
    }
  }
}

function sumThoughtDuration(thoughts: readonly ThoughtInfo[]): number | undefined {
  let total = 0
  let any = false

  for (const thought of thoughts) {
    if (thought.durationMs !== undefined) {
      total += thought.durationMs
      any = true
    }
  }

  return any ? total : undefined
}

function ToolActivity({
  item,
  showIdentity,
  context,
  className,
}: {
  item: Extract<FeedItem, { kind: 'tools' }>
  showIdentity: boolean
  context: ConversationContext
  className?: string
}) {
  const identity = context.identities.get(item.threadId)
  const liveTurn = context.liveByToolCardId.get(item.id)
  const liveThinking = liveTurn?.thinking.trim() ?? ''
  const hasThoughts = item.thoughts.length > 0
  const showThoughtHeader = hasThoughts || liveThinking.length > 0
  const showIdentityInCard = showIdentity && !showThoughtHeader
  const thoughtToggleKey = `tools_thought:${item.id}`
  const thoughtExpanded = Boolean(context.thoughtOpen.get(thoughtToggleKey))
  const totalThoughtDurationMs = sumThoughtDuration(item.thoughts)

  const changed = useMemo(() => changedPaths(item.calls), [item.calls])
  const runningCalls = item.calls.filter((call) => call.status === 'running')
  const running = runningCalls.length
  const lastRunningCall = runningCalls.at(-1)
  const failed = item.calls.filter((call) => call.status === 'error').length
  // A burst shows as its one-line summary until the reader opens it.
  const [open, setOpen] = useState(false)

  const summary =
    running > 0
      ? `running ${lastRunningCall?.name ?? 'tool'}…`
      : `used ${item.calls.length} tool${item.calls.length === 1 ? '' : 's'}`

  const collapsedDetail = !open && lastRunningCall ? toolArgsPreview(lastRunningCall) : ''

  return (
    <div className={cn('pl-10', className)}>
      {showThoughtHeader ? (
        <div className="mb-1.5 flex min-w-0 items-center gap-1.5 text-[11.5px]">
          {showIdentity ? (
            <>
              <button
                type="button"
                onClick={() => context.onInspect(item.threadId, item.seq)}
                className={cn(
                  'shrink-0 font-medium whitespace-nowrap hover:underline',
                  identity?.role.tone,
                )}
              >
                {identity?.label ?? 'Agent'}
              </button>
              <span className="text-muted-foreground/40 shrink-0 select-none">·</span>
            </>
          ) : null}
          <button
            type="button"
            aria-expanded={thoughtExpanded}
            onClick={() => context.setThoughtOpen(thoughtToggleKey, !thoughtExpanded)}
            className="text-muted-foreground/80 hover:text-foreground inline-flex min-w-0 items-center gap-1 text-left transition-colors duration-100"
          >
            <ChevronRight
              className={cn(
                'ease-snappy size-3 shrink-0 transition-transform duration-150',
                thoughtExpanded && 'rotate-90',
              )}
            />
            <span
              className={cn(
                'shrink-0 whitespace-nowrap tabular-nums',
                liveThinking && 'text-status-running breathe',
              )}
            >
              {liveThinking ? 'Thinking…' : formatThoughtLabel(totalThoughtDurationMs)}
            </span>
            {liveThinking && !thoughtExpanded ? (
              <span className="text-muted-foreground/60 min-w-0 truncate pl-1">
                {latestThoughtLine(liveThinking)}
              </span>
            ) : null}
          </button>
        </div>
      ) : null}
      {thoughtExpanded && showThoughtHeader ? (
        <div className="thinking-trace-body border-border/80 mb-2 ml-1 max-h-56 space-y-2.5 overflow-y-auto border-l py-0.5 pl-3">
          {item.thoughts.map((thought) => (
            <Markdown
              key={thought.id}
              text={thought.text}
              className="text-muted-foreground text-[12.5px] leading-relaxed"
            />
          ))}
          {liveThinking ? (
            <Markdown
              text={liveThinking}
              className="text-muted-foreground text-[12.5px] leading-relaxed"
            />
          ) : null}
        </div>
      ) : null}
      <div className="bg-card/60 rounded-lg border text-xs">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className={cn(
            'hover:bg-accent/40 flex h-8 w-full min-w-0 items-center gap-2 px-2.5 text-left transition-colors duration-100',
            open ? 'rounded-t-lg' : 'rounded-lg',
          )}
        >
          <ChevronRight
            className={cn(
              'text-muted-foreground ease-snappy size-3 shrink-0 transition-transform duration-150',
              open && 'rotate-90',
            )}
          />
          {showIdentityInCard ? (
            <span className={cn('shrink-0 font-medium whitespace-nowrap', identity?.role.tone)}>
              {identity?.label ?? 'Agent'}
            </span>
          ) : null}
          <span className="text-muted-foreground min-w-0 truncate">{summary}</span>
          {collapsedDetail ? (
            <span className="text-muted-foreground/60 min-w-0 truncate font-mono text-[11px]">
              {collapsedDetail}
            </span>
          ) : null}
          {failed > 0 ? (
            <span className="text-status-failed ml-auto inline-flex shrink-0 items-center gap-1 whitespace-nowrap">
              <TriangleAlert className="size-3 shrink-0" />
              {failed} failed
            </span>
          ) : null}
        </button>
        {open ? (
          <ul className="border-t px-1 py-1">
            {item.calls.map((call) => (
              <li key={call.toolCallId}>
                <button
                  type="button"
                  onClick={() => context.onInspect(item.threadId, call.seq)}
                  className="hover:bg-accent/50 flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left transition-colors duration-100"
                  title={call.error ?? compactJson(call.args, 400)}
                >
                  <ToolStatusIcon status={call.status} />
                  <span className="text-foreground shrink-0 font-mono text-[11px] whitespace-nowrap">
                    {call.name}
                  </span>
                  <span className="text-muted-foreground min-w-0 truncate font-mono text-[11px]">
                    {call.error ?? toolArgsPreview(call)}
                  </span>
                  {call.status === 'running' && call.startedAt !== undefined ? (
                    <RunningElapsed startedAt={call.startedAt} />
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {changed.length > 0 && context.onOpenArtifact ? (
        <div className="mt-1.5">
          <ArtifactLink icon={<FileDiff />} onOpen={() => context.onOpenArtifact?.('files')}>
            {changed.length === 1
              ? `Changed ${changed[0]?.split('/').pop() ?? '1 file'}`
              : `Changed ${changed.length.toLocaleString()} files`}
          </ArtifactLink>
        </div>
      ) : null}
    </div>
  )
}

/**
 * An agent's delegated work as one row: who did it, what it came to, and whether it is still
 * going. Opening it shows that agent's own timeline.
 */
function DelegationCard({
  row,
  context,
  className,
}: {
  row: DelegationRow
  context: ConversationContext
  className?: string
}) {
  const identity = context.identities.get(row.threadId)
  const node = context.threadNodes.get(row.threadId)
  const tone = node ? resolveThreadActivityTone(context.activity, node) : 'idle'
  const label = identity?.label ?? 'Agent'

  const facts = [
    row.agents > 1 ? `${row.agents.toLocaleString()} agents` : null,
    row.toolCalls > 0
      ? `${row.toolCalls.toLocaleString()} ${row.toolCalls === 1 ? 'step' : 'steps'}`
      : null,
    row.changedFiles > 0
      ? `${row.changedFiles.toLocaleString()} ${row.changedFiles === 1 ? 'file' : 'files'} changed`
      : null,
  ].filter((fact) => fact !== null)

  return (
    <div className={cn('pl-10', className)}>
      <button
        type="button"
        onClick={() => context.onOpenThread(row.threadId)}
        aria-label={`Open ${label}'s work`}
        className="group/delegation bg-card/60 hover:bg-accent/50 ease-snappy flex w-full min-w-0 items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition-[background-color,transform] duration-150 active:scale-[0.995]"
      >
        <AgentAvatar identity={identity} threadId={row.threadId} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2 text-[12px]">
            <span className="text-foreground/90 shrink-0 font-medium">{label}</span>
            <StatusDot status={tone} />
            {tone === 'idle' || tone === 'completed' ? null : (
              <span className={cn('shrink-0 text-[11px]', statusClass(tone))}>
                {statusLabel(tone)}
              </span>
            )}
            <span className="text-muted-foreground min-w-0 truncate text-[11.5px] tabular-nums">
              {facts.join(' · ')}
            </span>
            {row.failed > 0 ? (
              <span className="text-status-failed inline-flex shrink-0 items-center gap-1 text-[11.5px] tabular-nums">
                <TriangleAlert className="size-3" />
                {row.failed.toLocaleString()} failed
              </span>
            ) : null}
          </span>
          {row.lastText ? (
            <span className="text-muted-foreground truncate text-[12px]" dir="auto">
              {cleanSnippet(row.lastText.split('\n').find((line) => line.trim()) ?? '')}
            </span>
          ) : null}
        </span>
        <ChevronRight className="text-muted-foreground group-hover/delegation:text-foreground size-3.5 shrink-0 transition-colors duration-100" />
      </button>
    </div>
  )
}

function QuestionCard({
  item,
  context,
  className,
}: {
  item: Extract<FeedItem, { kind: 'question' }>
  context: ConversationContext
  className?: string
}) {
  if (item.approvalId.startsWith('pr_publish_')) {
    return <PullPublishCard item={item} context={context} className={className} />
  }

  if (item.approvalId.startsWith('pr_review_')) {
    return <PullReviewCard item={item} context={context} className={className} />
  }

  return <AskUserCard item={item} context={context} className={className} />
}

function AskUserCard({
  item,
  context,
  className,
}: {
  item: Extract<FeedItem, { kind: 'question' }>
  context: ConversationContext
  className?: string
}) {
  const identity = context.identities.get(item.threadId)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState<'answer' | 'defer' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const key = item.thought ? thoughtKey(item.threadId, item.thought.turn) : null
  const thoughtExpanded = key ? Boolean(context.thoughtOpen.get(key)) : false

  async function submit(answer: string | null) {
    setPending(answer === null ? 'defer' : 'answer')
    setError(null)

    try {
      await answerQuestion(context.runId, item.approvalId, answer)
    } catch (cause) {
      setError(errorMessage(cause))
      setPending(null)
    }
  }

  return (
    <div className={cn('flex gap-3', className)}>
      <AgentAvatar identity={identity} threadId={item.threadId} />
      <div
        className={cn(
          'min-w-0 flex-1 rounded-xl border p-3',
          item.decision ? 'bg-card/40' : 'bg-brand/6 border-brand/30',
        )}
      >
        <div className="text-muted-foreground flex items-center gap-2 text-[11px]">
          <MessageCircleQuestion
            className={cn('size-3.5 shrink-0', item.decision ? undefined : 'text-brand')}
          />
          <button
            type="button"
            onClick={() => context.onInspect(item.threadId, item.seq)}
            className="text-foreground/90 hover:text-foreground shrink-0 font-medium whitespace-nowrap hover:underline"
          >
            {identity?.label ?? 'Agent'} asks
          </button>
          <span className="message-time shrink-0 whitespace-nowrap tabular-nums">
            {clockTime(item.ts)}
          </span>
          {item.decision ? null : (
            <span className="text-brand ml-auto shrink-0 whitespace-nowrap">Waiting on you</span>
          )}
        </div>
        {item.thought && key ? (
          <ThinkingTrace
            text={item.thought.text}
            durationMs={item.thought.durationMs}
            activelyThinking={false}
            open={thoughtExpanded}
            onToggle={() => context.setThoughtOpen(key, !thoughtExpanded)}
          />
        ) : null}
        <p className="text-foreground/95 mt-1.5 text-[13.5px] leading-relaxed whitespace-pre-wrap">
          {humanize(item.title, context.identities)}
        </p>
        {item.decision ? (
          <p className="text-muted-foreground mt-2.5 flex items-start gap-1.5 border-t pt-2.5 text-xs">
            <CornerDownRight className="mt-0.5 size-3 shrink-0" />
            {item.decision.answer === null ? (
              <span className="italic">Left to the agent's judgment</span>
            ) : (
              <span className="text-foreground/90 whitespace-pre-wrap">{item.decision.answer}</span>
            )}
          </p>
        ) : (
          <form
            className="mt-3 flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault()

              if (draft.trim()) {
                void submit(draft.trim())
              }
            }}
          >
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  event.currentTarget.form?.requestSubmit()
                }
              }}
              placeholder="Type your answer…"
              disabled={pending !== null}
              className="max-h-40 min-h-10 resize-none"
            />
            <div className="flex items-center justify-end gap-2">
              {error ? <span className="text-status-failed mr-auto text-xs">{error}</span> : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={pending !== null}
                onClick={() => void submit(null)}
              >
                {pending === 'defer' ? <LoaderCircle className="animate-spin" /> : null}
                Use your judgment
              </Button>
              <Button
                type="submit"
                variant="brand"
                size="sm"
                disabled={pending !== null || !draft.trim()}
              >
                {pending === 'answer' ? <LoaderCircle className="animate-spin" /> : null}
                Answer
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

function PullReviewCard({
  item,
  context,
  className,
}: {
  item: Extract<FeedItem, { kind: 'question' }>
  context: ConversationContext
  className?: string
}) {
  const identity = context.identities.get(item.threadId)
  const drafts = context.feed.draftReviewComments

  const [summary, setSummary] = useState(
    item.title.replace(/^Submit pull request review\?\s*/i, '') || item.title,
  )

  const [verdict, setVerdict] = useState<'approve' | 'request_changes' | 'comment'>('comment')

  const [enabled, setEnabled] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(drafts.map((comment) => [comment.commentId, true])),
  )

  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function decide(actionId: 'submit' | 'discard') {
    setPending(actionId)
    setError(null)

    try {
      if (actionId === 'discard') {
        await decideStructuredApproval(context.runId, item.approvalId, {
          actionId: 'discard',
          outcome: 'reject',
        })
      } else {
        await decideStructuredApproval(context.runId, item.approvalId, {
          actionId: 'submit',
          outcome: 'approve',
          payload: {
            summary,
            verdict,
            comments: drafts
              .filter((comment) => enabled[comment.commentId] !== false)
              .map((comment) => ({
                path: comment.path,
                line: comment.line,
                side: comment.side,
                body: comment.body,
              })),
          },
        })
      }
    } catch (cause) {
      setError(errorMessage(cause))
      setPending(null)
    }
  }

  return (
    <div className={cn('flex gap-3', className)}>
      <AgentAvatar identity={identity} threadId={item.threadId} />
      <div
        className={cn(
          'min-w-0 flex-1 rounded-xl border p-3',
          item.decision ? 'bg-card/40' : 'border-brand/30 bg-brand/6',
        )}
      >
        <div className="text-muted-foreground flex items-center gap-2 text-[11px]">
          <GitPullRequest
            className={cn('size-3.5 shrink-0', item.decision ? undefined : 'text-brand')}
          />
          <span className="text-foreground/90 font-medium">Submit review</span>
          <span className="message-time shrink-0 whitespace-nowrap tabular-nums">
            {clockTime(item.ts)}
          </span>
          {item.decision ? null : (
            <span className="text-brand ml-auto shrink-0">Needs approval</span>
          )}
        </div>
        {item.decision ? (
          <p className="text-muted-foreground mt-2 text-xs">
            {item.decision.answer === null ? 'Discarded' : item.decision.answer}
          </p>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            <Textarea
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              disabled={pending !== null}
              className="min-h-20 resize-none text-[13px]"
            />
            {drafts.length > 0 ? (
              <ul className="flex flex-col gap-1.5">
                {drafts.map((comment) => (
                  <li
                    key={comment.commentId}
                    className="bg-background/60 flex items-start gap-2 rounded-md border px-2 py-1.5 text-[11px]"
                  >
                    <input
                      type="checkbox"
                      checked={enabled[comment.commentId] !== false}
                      disabled={pending !== null}
                      onChange={(event) =>
                        setEnabled((prev) => ({
                          ...prev,
                          [comment.commentId]: event.target.checked,
                        }))
                      }
                      className="mt-0.5 size-3"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-muted-foreground font-mono">
                        {comment.path}:{comment.line} · {comment.severity}
                      </p>
                      <p className="text-foreground/90 mt-0.5 whitespace-pre-wrap">
                        {comment.body}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {(['comment', 'approve', 'request_changes'] as const).map((option) => (
                <Button
                  key={option}
                  type="button"
                  size="sm"
                  variant={verdict === option ? 'brand' : 'outline'}
                  disabled={pending !== null}
                  onClick={() => setVerdict(option)}
                >
                  {option === 'request_changes'
                    ? 'Request changes'
                    : option === 'approve'
                      ? 'Approve'
                      : 'Comment'}
                </Button>
              ))}
            </div>
            <div className="flex items-center justify-end gap-2">
              {error ? <span className="text-status-failed mr-auto text-xs">{error}</span> : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={pending !== null}
                onClick={() => void decide('discard')}
              >
                Discard
              </Button>
              <Button
                type="button"
                variant="brand"
                size="sm"
                disabled={pending !== null}
                onClick={() => void decide('submit')}
              >
                Submit review
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Notice({
  item,
  context,
  className,
}: {
  item: Extract<FeedItem, { kind: 'notice' }>
  context: ConversationContext
  className?: string
}) {
  const identity = item.threadId ? context.identities.get(item.threadId) : undefined

  return (
    <div className={cn('flex items-center gap-3 py-1 text-[11px]', className)}>
      <span className="bg-border h-px flex-1" />
      <span
        className={cn(
          'inline-flex max-w-[80%] items-center gap-1.5 text-center',
          item.tone === 'error' ? 'text-status-failed' : 'text-muted-foreground',
        )}
      >
        {item.runId ? <Sparkles className="text-route-constraint size-3 shrink-0" /> : null}
        {item.tone === 'error' ? <TriangleAlert className="size-3 shrink-0" /> : null}
        <span className="truncate">
          {identity ? `${identity.label}: ` : ''}
          {humanize(item.text, context.identities)}
        </span>
        {item.runId ? (
          <Link to="/playbook" className="text-foreground shrink-0 font-medium hover:underline">
            Open playbook
          </Link>
        ) : null}
      </span>
      <span className="bg-border h-px flex-1" />
    </div>
  )
}

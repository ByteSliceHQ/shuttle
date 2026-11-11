import { Link } from '@tanstack/react-router'
import {
  ArrowRight,
  Check,
  ChevronRight,
  CornerDownRight,
  LoaderCircle,
  MessageCircleQuestion,
  MessageSquareDashed,
  Shuffle,
  Sparkles,
  TriangleAlert,
  X,
} from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { AgentIdentity } from '@/lib/agents'
import { agentRole } from '@/lib/agents'
import { answerQuestion, reroute } from '@/lib/api'
import { cn, compactJson, errorMessage } from '@/lib/cn'
import { jsonFields, jsonText } from '@/lib/json'
import { routeStyles } from '@/lib/routes'
import {
  interjectionKinds,
  type FeedItem,
  type RouteDelivery,
  type RouteInfo,
  type SessionFeed,
  type ToolCallItem,
} from '@/lib/session-feed'
import { clockTime } from '@/lib/time'

import { FollowList } from './follow-list'
import { Markdown } from './markdown'
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
  | FeedItem
  | {
      readonly kind: 'stream'
      readonly id: string
      readonly threadId: string
      readonly text: string
    }

interface ConversationContext {
  readonly runId: string
  readonly feed: SessionFeed
  readonly identities: ReadonlyMap<string, AgentIdentity>
  readonly onInspect: (threadId: string, seq?: number) => void
}

export function Conversation({
  runId,
  feed,
  streaming,
  identities,
  onInspect,
}: {
  runId: string
  feed: SessionFeed
  streaming: Readonly<Record<string, string>>
  identities: ReadonlyMap<string, AgentIdentity>
  onInspect: (threadId: string, seq?: number) => void
}) {
  const rows = useMemo<readonly Row[]>(() => {
    const live = Object.entries(streaming)
      .filter(([, text]) => text.trim().length > 0)
      .map(([threadId, text]) => ({
        kind: 'stream' as const,
        id: `stream_${threadId}`,
        threadId,
        text,
      }))

    return [...feed.items, ...live]
  }, [feed.items, streaming])

  // History replayed on load renders still; live arrivals settle in once, even if virtualization remounts them.
  const [mountedAt] = useState(() => Date.now())
  const animated = useRef(new Set<string>())

  const onSettled = useCallback((id: string) => {
    animated.current.add(id)
  }, [])

  const context = useMemo<ConversationContext>(
    () => ({ runId, feed, identities, onInspect }),
    [runId, feed, identities, onInspect],
  )

  return (
    <FollowList
      items={rows}
      getKey={(row) => row.id}
      estimateSize={72}
      overscan={6}
      paddingStart={16}
      paddingEnd={28}
      viewportClassName="conversation-fade"
      itemClassName="px-4 sm:px-6"
      empty={
        <EmptyState icon={<MessageSquareDashed />} title="Connecting to the session">
          Events stream in from the Durable Object as soon as the run starts.
        </EmptyState>
      }
      renderItem={(row) => (
        <div className="mx-auto w-full max-w-3xl py-1.5">
          <RowView
            row={row}
            context={context}
            animate={('ts' in row ? row.ts >= mountedAt : true) && !animated.current.has(row.id)}
            onSettled={onSettled}
          />
        </div>
      )}
    />
  )
}

const RowView = memo(function RowView({
  row,
  context,
  animate,
  onSettled,
}: {
  row: Row
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
    case 'tools':
      return <ToolActivity className={className} item={row} context={context} />
    case 'question':
      return <QuestionCard className={className} item={row} context={context} />
    case 'notice':
      return <Notice className={className} item={row} context={context} />
    case 'stream':
      return (
        <AgentBubble
          className={className}
          identity={context.identities.get(row.threadId)}
          threadId={row.threadId}
          text={row.text}
          streaming
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
  return (
    <div className={cn('group/user flex flex-col items-end gap-1.5', className)}>
      <div className="text-muted-foreground flex items-center gap-2 pr-1 text-[11px]">
        <span className="text-foreground/80 font-medium">{item.goal ? 'Goal' : 'You'}</span>
        <span className="tabular-nums">{clockTime(item.ts)}</span>
      </div>
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
      {item.goal ? null : (
        <RouteChip
          runId={context.runId}
          messageId={item.messageId}
          route={route}
          deliveries={deliveries}
          classifying={classifying}
          forced={item.forced !== undefined}
          identities={context.identities}
          onInspect={context.onInspect}
        />
      )}
    </div>
  )
}

function RouteChip({
  runId,
  messageId,
  route,
  deliveries,
  classifying,
  forced,
  identities,
  onInspect,
}: {
  runId: string
  messageId: string
  route: RouteInfo | undefined
  deliveries: readonly RouteDelivery[]
  classifying: boolean
  forced: boolean
  identities: ReadonlyMap<string, AgentIdentity>
  onInspect: (threadId: string, seq?: number) => void
}) {
  if (!route) {
    return (
      <span className="text-muted-foreground inline-flex h-6 items-center gap-1.5 pr-1 text-[11px]">
        <LoaderCircle className="size-3 animate-spin" />
        {classifying ? 'Intake is classifying…' : 'Queued for intake'}
      </span>
    )
  }

  const style = routeStyles[route.kind]
  const Icon = style.icon
  const targets = [...new Map(deliveries.map((entry) => [entry.threadId, entry])).values()]

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
          return (
            <button
              key={delivery.threadId}
              type="button"
              onClick={() => onInspect(delivery.threadId)}
              className="text-muted-foreground hover:text-foreground hover:bg-accent inline-flex h-6 items-center gap-1 rounded-full border px-2 transition-colors duration-100"
              title={
                delivery.interrupt ? 'Interrupted the current turn' : 'Queued for the next step'
              }
            >
              <ArrowRight className="size-3" />
              {identity?.label ?? 'agent'}
              {delivery.interrupt ? (
                <span className="text-route-correction font-medium">interrupt</span>
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

function AgentBubble({
  identity,
  threadId,
  text,
  ts,
  seq,
  replyTo,
  streaming = false,
  onInspect,
  className,
}: {
  identity?: AgentIdentity
  threadId: string
  text: string
  ts?: number
  seq?: number
  replyTo?: string
  streaming?: boolean
  onInspect: (threadId: string, seq?: number) => void
  className?: string
}) {
  return (
    <div className={cn('flex gap-3', className)}>
      <AgentAvatar identity={identity} threadId={threadId} />
      <div className="min-w-0 flex-1">
        <div className="text-muted-foreground flex items-center gap-2 text-[11px]">
          <button
            type="button"
            onClick={() => onInspect(threadId, seq)}
            className="text-foreground/90 hover:text-foreground font-medium hover:underline"
          >
            {identity?.label ?? 'Agent'}
          </button>
          {ts !== undefined ? <span className="tabular-nums">{clockTime(ts)}</span> : null}
          {streaming ? <span className="text-status-running">typing</span> : null}
        </div>
        {replyTo ? (
          <p className="text-muted-foreground mt-1 flex items-center gap-1 truncate text-[11px]">
            <CornerDownRight className="size-3 shrink-0" />
            <span className="truncate italic">{replyTo}</span>
          </p>
        ) : null}
        <Markdown
          text={text}
          className={cn(
            'text-foreground/95 mt-1 text-[13.5px] leading-relaxed',
            streaming && 'caret',
          )}
        />
      </div>
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
      text={item.text}
      ts={item.ts}
      seq={item.seq}
      replyTo={replyTo}
      onInspect={context.onInspect}
    />
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
      return <LoaderCircle className="text-status-running size-3 animate-spin" />
    case 'ok':
      return <Check className="text-status-completed size-3" />
    case 'error':
      return <X className="text-status-failed size-3" />

    default: {
      const exhaustive: never = status
      return exhaustive
    }
  }
}

function ToolActivity({
  item,
  context,
  className,
}: {
  item: Extract<FeedItem, { kind: 'tools' }>
  context: ConversationContext
  className?: string
}) {
  const identity = context.identities.get(item.threadId)
  const running = item.calls.filter((call) => call.status === 'running').length
  const failed = item.calls.filter((call) => call.status === 'error').length
  // Short bursts stay expanded; long ones collapse until the reader opens them.
  const [choice, setOpen] = useState<boolean | null>(null)
  const open = choice ?? item.calls.length <= 4

  return (
    <div className={cn('pl-10', className)}>
      <div className="bg-card/60 rounded-lg border text-xs">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="hover:bg-accent/40 flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left transition-colors duration-100"
        >
          <ChevronRight
            className={cn(
              'text-muted-foreground ease-snappy size-3 shrink-0 transition-transform duration-150',
              open && 'rotate-90',
            )}
          />
          <span className={cn('font-medium', identity?.role.tone)}>
            {identity?.label ?? 'Agent'}
          </span>
          <span className="text-muted-foreground">
            {running > 0
              ? `running ${item.calls.at(-1)?.name ?? 'tool'}…`
              : `used ${item.calls.length} tool${item.calls.length === 1 ? '' : 's'}`}
          </span>
          {failed > 0 ? (
            <span className="text-status-failed ml-auto inline-flex items-center gap-1">
              <TriangleAlert className="size-3" />
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
                  <span className="text-foreground shrink-0 font-mono text-[11px]">
                    {call.name}
                  </span>
                  <span className="text-muted-foreground min-w-0 truncate font-mono text-[11px]">
                    {call.error ?? toolArgsPreview(call)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
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
  const identity = context.identities.get(item.threadId)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState<'answer' | 'defer' | null>(null)
  const [error, setError] = useState<string | null>(null)

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
            className={cn('size-3.5', item.decision ? undefined : 'text-brand')}
          />
          <button
            type="button"
            onClick={() => context.onInspect(item.threadId, item.seq)}
            className="text-foreground/90 hover:text-foreground font-medium hover:underline"
          >
            {identity?.label ?? 'Agent'} asks
          </button>
          <span className="tabular-nums">{clockTime(item.ts)}</span>
          {item.decision ? null : <span className="text-brand ml-auto">Waiting on you</span>}
        </div>
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
            Playbook
          </Link>
        ) : null}
      </span>
      <span className="bg-border h-px flex-1" />
    </div>
  )
}

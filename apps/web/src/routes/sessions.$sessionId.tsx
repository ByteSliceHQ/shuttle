import { createFileRoute, Link } from '@tanstack/react-router'
import { Check, Copy, Folder, MessagesSquare, PanelRight, Users } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { AgentTree } from '@/components/agent-tree'
import { ArtifactPane } from '@/components/artifacts/artifact-pane'
import { Composer } from '@/components/composer'
import { Conversation } from '@/components/conversation'
import { SessionContextButtons } from '@/components/session-context'
import { SessionPrPills } from '@/components/session-pr-pills'
import { SessionRepos } from '@/components/session-repos'
import { SessionShare } from '@/components/session-share'
import { useReportLiveSession, useWorkspace } from '@/components/sidebar/workspace-context'
import { StatusBadge } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { PanelHeader, PanelTitle } from '@/components/ui/panel'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { agentIdentities, withVendorAgents } from '@/lib/agents'
import { fetchSessionHarness, stopThread, type HarnessId } from '@/lib/api'
import { shortId } from '@/lib/cn'
import { possessive, useOrgPeople } from '@/lib/org-people'
import { authoredPullsForSession, pullInbox, usePullsRunId, type PullInboxState } from '@/lib/pulls'
import { rememberSession } from '@/lib/recent-sessions'
import { sessionActivity, type SessionActivity } from '@/lib/session-activity'
import {
  sessionFeed,
  vendorLiveFeed,
  withLiveVendorSteps,
  streamingTurns,
  type PublishedPull,
  type SessionFeed,
} from '@/lib/session-feed'
import { useTenant } from '@/lib/tenant'
import { useWidthBucket } from '@/lib/use-width-bucket'
import type { RunStatus } from '@swirls/looms/core'
import {
  type LoomsConnectionStatus,
  useEventCounts,
  useLiveFold,
  useProjection,
  useRunEvents,
  useRunStore,
  useRunSummary,
  useThreadTree,
} from '@swirls/looms/react'

interface SessionSearch {
  /** Agent thread to inspect on open, e.g. the one that opened a linked PR. */
  readonly thread?: string
}

export const Route = createFileRoute('/sessions/$sessionId')({
  validateSearch: (search: Record<string, unknown>): SessionSearch =>
    typeof search.thread === 'string' && search.thread ? { thread: search.thread } : {},
  component: SessionPage,
})

function SessionPage() {
  const { sessionId } = Route.useParams()
  const { thread } = Route.useSearch()
  return <SessionWorkspace key={sessionId} runId={sessionId} focusThreadId={thread} />
}

/**
 * Session-area widths, in CSS pixels, at which a pane is added. Below the first only the
 * conversation shows (events open over it); from the second the agents pane joins.
 */
const PANE_BREAKPOINTS = [640, 980] as const

type PaneLayout = 'one' | 'two' | 'three'

function SessionWorkspace({ runId, focusThreadId }: { runId: string; focusThreadId?: string }) {
  const store = useRunStore(runId)
  const summary = useRunSummary(store)
  const tree = useThreadTree(store)
  const events = useRunEvents(store)
  const eventCounts = useEventCounts(store)
  const durableFeed = useProjection(store, sessionFeed)
  const liveVendorSteps = useLiveFold(store, vendorLiveFeed)

  const feed = useMemo(
    () => withLiveVendorSteps(durableFeed, liveVendorSteps),
    [durableFeed, liveVendorSteps],
  )

  const activityState = useProjection(store, sessionActivity)
  const streaming = useLiveFold(store, streamingTurns)
  const reportLiveSession = useReportLiveSession()

  const [selectedThreadId, setSelectedThreadId] = useState<string | undefined>()
  const [selectedSeq, setSelectedSeq] = useState<number | undefined>()
  const [focusEventsToken, setFocusEventsToken] = useState(0)
  const [layoutRef, paneCount] = useWidthBucket<HTMLDivElement>(PANE_BREAKPOINTS)
  const layout: PaneLayout = paneCount >= 2 ? 'three' : paneCount === 1 ? 'two' : 'one'
  // Only read in the one-pane layout, where the artifact pane opens over the conversation.
  const [artifactsOpen, setArtifactsOpen] = useState(false)

  // Which agent runs the session is known before its first step, so the thread carries the
  // agent's name from the start and never shows as Shuttle's conductor first.
  const [harness, setHarness] = useState<HarnessId>('shuttle')

  useEffect(() => {
    fetchSessionHarness(runId).then(
      (result) => setHarness(result.harness),
      () => {},
    )
  }, [runId])

  const me = useTenant().user.id
  const people = useOrgPeople()

  const identities = useMemo(
    () =>
      withVendorAgents(agentIdentities(tree.root), feed.vendorAgents, harness, (userId) =>
        possessive(userId, me, people),
      ),
    [tree.root, feed.vendorAgents, harness, me, people],
  )

  const goal = feed.items.find((item) => item.kind === 'user' && item.goal)
  const hasInterjected = feed.items.some((item) => item.kind === 'user' && !item.goal)
  const goalText = goal?.kind === 'user' ? goal.text : undefined
  const folderId = useWorkspace()?.tree.sessions[runId]?.folderId

  useEffect(() => {
    if (goalText) {
      rememberSession({ runId, goal: goalText })
    }
  }, [runId, goalText])

  useEffect(() => {
    if (summary.startedAt !== undefined) {
      reportLiveSession(runId, {
        status: summary.status,
        activity: activityState.activity,
      })
    }
  }, [runId, summary.startedAt, summary.status, activityState.activity, reportLiveSession])

  const labelFor = useCallback(
    (threadId: string | null) => (threadId ? identities.get(threadId)?.label : undefined),
    [identities],
  )

  const inspect = useCallback((threadId: string, seq?: number) => {
    setSelectedThreadId(threadId)
    setSelectedSeq(seq)
    setFocusEventsToken((token) => token + 1)
    setArtifactsOpen(true)
  }, [])

  const focusThreadKnown = focusThreadId !== undefined && identities.has(focusThreadId)
  const [focusedThreadId, setFocusedThreadId] = useState<string | undefined>()

  if (focusThreadKnown && focusedThreadId !== focusThreadId) {
    setFocusedThreadId(focusThreadId)
    setSelectedThreadId(focusThreadId)
    setSelectedSeq(undefined)
    setFocusEventsToken((token) => token + 1)
  }

  const artifacts = (
    <ArtifactPane
      runId={runId}
      folderId={folderId}
      events={events}
      startedAt={summary.startedAt}
      threadId={selectedThreadId}
      threadLabel={labelFor(selectedThreadId ?? null)}
      labelFor={labelFor}
      onClearThread={() => setSelectedThreadId(undefined)}
      selectedSeq={selectedSeq}
      onSelectSeq={setSelectedSeq}
      focusEventsToken={focusEventsToken}
    />
  )

  return (
    <div ref={layoutRef} className="flex h-full min-h-0 flex-col">
      <SessionHeader
        runId={runId}
        goal={goalText}
        status={summary.status}
        activity={summary.startedAt !== undefined ? activityState.activity : 'working'}
        connection={summary.connection}
        feed={feed}
        labelFor={labelFor}
        onInspect={inspect}
        artifactsToggle={
          layout === 'one'
            ? { open: artifactsOpen, onToggle: () => setArtifactsOpen((open) => !open) }
            : undefined
        }
      />
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        {layout === 'three' ? (
          <>
            <ResizablePanel id="agents" defaultSize="18" minSize={200} maxSize="30">
              <aside className="bg-sidebar flex h-full min-h-0 flex-col">
                <PanelHeader>
                  <Users className="text-muted-foreground size-3.5" />
                  <PanelTitle meta={identities.size || undefined}>Agents</PanelTitle>
                </PanelHeader>
                <AgentTree
                  root={tree.root}
                  activityState={activityState}
                  identities={identities}
                  eventCounts={eventCounts}
                  totalEventCount={events.length}
                  selectedThreadId={selectedThreadId}
                  onSelect={(threadId) => {
                    setSelectedThreadId(threadId)
                    setSelectedSeq(undefined)
                  }}
                  onStop={(threadId) => stopThread(runId, threadId)}
                />
              </aside>
            </ResizablePanel>
            <ResizableHandle />
          </>
        ) : null}
        <ResizablePanel id="conversation" defaultSize="52" minSize={layout === 'one' ? 0 : 320}>
          <main className="relative flex h-full min-h-0 flex-col">
            <Conversation
              runId={runId}
              feed={feed}
              activity={activityState}
              streaming={streaming}
              identities={identities}
              onInspect={inspect}
            />
            <Composer
              runId={runId}
              harness={harness}
              onHarnessChange={setHarness}
              identities={identities}
              disabled={summary.finished}
              showExamples={!hasInterjected}
            />
            {layout === 'one' && artifactsOpen ? (
              <aside className="bg-background absolute inset-0 z-20 min-h-0">{artifacts}</aside>
            ) : null}
          </main>
        </ResizablePanel>
        {layout === 'one' ? null : (
          <>
            <ResizableHandle />
            <ResizablePanel id="artifacts" defaultSize="30" minSize={280}>
              <aside className="h-full min-h-0">{artifacts}</aside>
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </div>
  )
}

function SessionHeader({
  runId,
  goal,
  status,
  activity,
  connection,
  feed,
  labelFor,
  onInspect,
  artifactsToggle,
}: {
  runId: string
  goal: string | undefined
  status: RunStatus
  activity: SessionActivity
  connection: LoomsConnectionStatus
  feed: SessionFeed
  labelFor: (threadId: string | null) => string | undefined
  onInspect: (threadId: string) => void
  /** Present only in the one-pane layout, where events and files open over the conversation. */
  artifactsToggle?: { readonly open: boolean; readonly onToggle: () => void }
}) {
  const [copied, setCopied] = useState(false)
  const tree = useWorkspace()?.tree
  const sessionMeta = tree?.sessions[runId]
  const folder = sessionMeta ? tree?.folders[sessionMeta.folderId] : undefined
  const title = sessionMeta?.title ?? goal ?? 'Coding session'
  const pullsStore = useRunStore(usePullsRunId())
  const inbox = useProjection(pullsStore, pullInbox)

  const sessionPulls = useMemo(
    () => mergeSessionPulls(feed.publishedPulls, inbox, runId),
    [feed.publishedPulls, inbox, runId],
  )

  const badgeStatus =
    status === 'completed' || status === 'failed' || status === 'cancelled' ? status : activity

  // Two columns: the title only ever truncates, so its length never moves the controls.
  // The controls drop out by priority as the header narrows; status and pull requests stay.
  return (
    <header className="@container grid h-12 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-b px-3 @2xl:gap-4">
      <div className="flex min-w-0 items-center gap-1.5">
        {folder ? (
          <>
            <Link
              to="/folders/$folderId"
              params={{ folderId: folder.folderId }}
              title={folder.name}
              className="text-muted-foreground hover:text-foreground hidden max-w-40 shrink-0 items-center gap-1.5 text-[12px] transition-colors duration-100 sm:inline-flex"
            >
              <Folder className="size-3.5 shrink-0" />
              <span className="truncate" dir="auto">
                {folder.name}
              </span>
            </Link>
            <span aria-hidden className="text-muted-foreground/50 hidden text-[12px] sm:inline">
              /
            </span>
          </>
        ) : null}
        <h1 className="min-w-0 truncate text-[13px] font-medium" dir="auto" title={title}>
          {title}
        </h1>
      </div>
      <div className="flex items-center gap-1">
        <SessionPrPills pulls={sessionPulls} labelFor={labelFor} onInspect={onInspect} />
        <SessionShare key={runId} runId={runId} />
        <ConnectionIndicator connection={connection} />
        <StatusBadge status={badgeStatus} className="mr-1" />
        {folder ? (
          <div className="hidden @xl:contents">
            <SessionRepos
              folderId={folder.folderId}
              folderName={folder.name}
              repos={folder.repos}
            />
          </div>
        ) : null}
        <div className="hidden @3xl:contents">
          <SessionContextButtons feed={feed} />
        </div>
        <div className="hidden @4xl:contents">
          <span aria-hidden className="bg-border mx-1 h-4 w-px" />
          <Button
            variant="ghost"
            size="sm"
            className="font-mono"
            title={`Copy run id ${runId}`}
            onClick={() => {
              void navigator.clipboard.writeText(runId).then(() => setCopied(true))
            }}
            onPointerLeave={() => setCopied(false)}
          >
            {copied ? <Check className="text-status-completed" /> : <Copy />}
            {shortId(runId)}
          </Button>
        </div>
        {artifactsToggle ? (
          <Button
            variant={artifactsToggle.open ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={artifactsToggle.open}
            onClick={artifactsToggle.onToggle}
          >
            {artifactsToggle.open ? <MessagesSquare /> : <PanelRight />}
            {artifactsToggle.open ? 'Chat' : 'Events'}
          </Button>
        ) : null}
      </div>
    </header>
  )
}

function mergeSessionPulls(
  published: readonly PublishedPull[],
  inbox: PullInboxState,
  runId: string,
): PublishedPull[] {
  const byKey = new Map<string, PublishedPull>()

  for (const pull of authoredPullsForSession(inbox, runId)) {
    byKey.set(`${pull.fullName}#${pull.number}`, pull)
  }

  for (const pull of published) {
    const key = `${pull.fullName}#${pull.number}`
    const existing = byKey.get(key)

    byKey.set(key, {
      ...pull,
      threadId: pull.threadId ?? existing?.threadId,
      stack: pull.stack ?? existing?.stack,
    })
  }

  return [...byKey.values()]
}

/** Silent while live; only a degraded connection earns header space. */
function ConnectionIndicator({ connection }: { connection: LoomsConnectionStatus }) {
  switch (connection) {
    case 'live':
      return null
    case 'connecting':
    case 'reconnecting':
      return (
        <span className="text-status-waiting inline-flex items-center gap-1.5 text-[11px]">
          <span className="bg-status-waiting size-1.5 animate-pulse rounded-full" />
          {connection === 'connecting' ? 'Connecting' : 'Reconnecting'}
        </span>
      )

    default: {
      const exhaustive: never = connection
      return exhaustive
    }
  }
}

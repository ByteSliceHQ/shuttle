import { createFileRoute, Link } from '@tanstack/react-router'
import { Check, Copy, Folder, Users } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { AgentTree } from '@/components/agent-tree'
import { ArtifactPane } from '@/components/artifacts/artifact-pane'
import { Composer } from '@/components/composer'
import { Conversation } from '@/components/conversation'
import { SessionContextButtons } from '@/components/session-context'
import { SessionRepos } from '@/components/session-repos'
import { useReportLiveSession, useWorkspace } from '@/components/sidebar/workspace-context'
import { StatusBadge } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { PanelHeader, PanelTitle } from '@/components/ui/panel'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { agentIdentities } from '@/lib/agents'
import { shortId } from '@/lib/cn'
import { rememberSession } from '@/lib/recent-sessions'
import { sessionActivity, type SessionActivity } from '@/lib/session-activity'
import { sessionFeed, streamingTurns, type SessionFeed } from '@/lib/session-feed'
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

export const Route = createFileRoute('/sessions/$sessionId')({
  component: SessionPage,
})

function SessionPage() {
  const { sessionId } = Route.useParams()
  return <SessionWorkspace key={sessionId} runId={sessionId} />
}

function SessionWorkspace({ runId }: { runId: string }) {
  const store = useRunStore(runId)
  const summary = useRunSummary(store)
  const tree = useThreadTree(store)
  const events = useRunEvents(store)
  const eventCounts = useEventCounts(store)
  const feed = useProjection(store, sessionFeed)
  const activityState = useProjection(store, sessionActivity)
  const streaming = useLiveFold(store, streamingTurns)
  const reportLiveSession = useReportLiveSession()

  const [selectedThreadId, setSelectedThreadId] = useState<string | undefined>()
  const [selectedSeq, setSelectedSeq] = useState<number | undefined>()
  const [focusEventsToken, setFocusEventsToken] = useState(0)

  const identities = useMemo(() => agentIdentities(tree.root), [tree.root])
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
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SessionHeader
        runId={runId}
        goal={goalText}
        status={summary.status}
        activity={summary.startedAt !== undefined ? activityState.activity : 'working'}
        connection={summary.connection}
        feed={feed}
      />
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel defaultSize="18" minSize={200} maxSize="30">
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
            />
          </aside>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize="52" minSize={360}>
          <main className="flex h-full min-h-0 flex-col">
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
              identities={identities}
              disabled={summary.finished}
              showExamples={!hasInterjected}
            />
          </main>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize="30" minSize={280}>
          <aside className="h-full min-h-0">
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
              identities={identities}
              focusEventsToken={focusEventsToken}
            />
          </aside>
        </ResizablePanel>
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
}: {
  runId: string
  goal: string | undefined
  status: RunStatus
  activity: SessionActivity
  connection: LoomsConnectionStatus
  feed: SessionFeed
}) {
  const [copied, setCopied] = useState(false)
  const tree = useWorkspace()?.tree
  const sessionMeta = tree?.sessions[runId]
  const folder = sessionMeta ? tree?.folders[sessionMeta.folderId] : undefined
  const title = sessionMeta?.title ?? goal ?? 'Coding session'

  const badgeStatus =
    status === 'completed' || status === 'failed' || status === 'cancelled' ? status : activity

  // Two columns: the title only ever truncates, so its length never moves the controls.
  return (
    <header className="grid h-12 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b px-3">
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
        <ConnectionIndicator connection={connection} />
        <StatusBadge status={badgeStatus} className="mr-1" />
        {folder ? (
          <SessionRepos folderId={folder.folderId} folderName={folder.name} repos={folder.repos} />
        ) : null}
        <SessionContextButtons feed={feed} />
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
    </header>
  )
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

import { createFileRoute, Link } from '@tanstack/react-router'
import { BookOpen, Check, Copy, FileText, Folder, Users } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { AgentTree } from '@/components/agent-tree'
import { Composer } from '@/components/composer'
import { Conversation } from '@/components/conversation'
import { EventStream } from '@/components/event-stream'
import { RepoChip } from '@/components/sidebar/repo-chip'
import { useWorkspace } from '@/components/sidebar/workspace-context'
import { StatusBadge } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { PanelHeader, PanelTitle, SectionLabel } from '@/components/ui/panel'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { ScrollArea } from '@/components/ui/scroll-area'
import { agentIdentities } from '@/lib/agents'
import { cn, shortId } from '@/lib/cn'
import { rememberSession } from '@/lib/recent-sessions'
import {
  currentBrief,
  sessionFeed,
  streamingText,
  type BriefRevision,
  type SessionFeed,
} from '@/lib/session-feed'
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
  const streaming = useLiveFold(store, streamingText)

  const [selectedThreadId, setSelectedThreadId] = useState<string | undefined>()
  const [selectedSeq, setSelectedSeq] = useState<number | undefined>()

  const identities = useMemo(() => agentIdentities(tree.root), [tree.root])
  const goal = feed.items.find((item) => item.kind === 'user' && item.goal)
  const hasInterjected = feed.items.some((item) => item.kind === 'user' && !item.goal)
  const goalText = goal?.kind === 'user' ? goal.text : undefined

  useEffect(() => {
    if (goalText) {
      rememberSession({ runId, goal: goalText })
    }
  }, [runId, goalText])

  const labelFor = useCallback(
    (threadId: string | null) => (threadId ? identities.get(threadId)?.label : undefined),
    [identities],
  )

  const inspect = useCallback((threadId: string, seq?: number) => {
    setSelectedThreadId(threadId)
    setSelectedSeq(seq)
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SessionHeader
        runId={runId}
        goal={goalText}
        status={summary.status}
        connection={summary.connection}
        playbookVersion={feed.playbook.version}
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
              identities={identities}
              eventCounts={eventCounts}
              totalEventCount={events.length}
              selectedThreadId={selectedThreadId}
              onSelect={(threadId) => {
                setSelectedThreadId(threadId)
                setSelectedSeq(undefined)
              }}
            />
            <SessionContext feed={feed} />
          </aside>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize="52" minSize={360}>
          <main className="flex h-full min-h-0 flex-col">
            <Conversation
              runId={runId}
              feed={feed}
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
          <aside className="bg-sidebar h-full min-h-0">
            <EventStream
              events={events}
              startedAt={summary.startedAt}
              threadId={selectedThreadId}
              threadLabel={labelFor(selectedThreadId ?? null)}
              labelFor={labelFor}
              onClearThread={() => setSelectedThreadId(undefined)}
              selectedSeq={selectedSeq}
              onSelectSeq={setSelectedSeq}
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
  connection,
  playbookVersion,
}: {
  runId: string
  goal: string | undefined
  status: RunStatus
  connection: LoomsConnectionStatus
  playbookVersion: number
}) {
  const [copied, setCopied] = useState(false)

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b px-3">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <SessionFolderContext sessionRunId={runId} goal={goal} />
        <StatusBadge status={status} />
        <ConnectionIndicator connection={connection} />
      </div>
      {playbookVersion > 0 ? (
        <Button variant="ghost" size="sm" asChild>
          <Link to="/playbook">
            <BookOpen />
            Playbook v{playbookVersion}
          </Link>
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        className="font-mono"
        title={runId}
        onClick={() => {
          void navigator.clipboard.writeText(runId).then(() => setCopied(true))
        }}
        onPointerLeave={() => setCopied(false)}
      >
        {copied ? <Check className="text-status-completed" /> : <Copy />}
        {shortId(runId)}
      </Button>
    </header>
  )
}

const HEADER_REPOS = 2

function SessionFolderContext({
  sessionRunId,
  goal,
}: {
  sessionRunId: string
  goal: string | undefined
}) {
  const tree = useWorkspace()?.tree
  const sessionMeta = tree?.sessions[sessionRunId]
  const folder = sessionMeta ? tree?.folders[sessionMeta.folderId] : undefined
  const title = sessionMeta?.title ?? goal ?? 'Coding session'
  const extraRepos = folder ? folder.repos.length - HEADER_REPOS : 0

  return (
    <>
      {folder ? (
        <Link
          to="/folders/$folderId"
          params={{ folderId: folder.folderId }}
          title={folder.name}
          className="text-muted-foreground hover:text-foreground inline-flex max-w-40 shrink-0 items-center gap-1 text-[12px] transition-colors duration-100"
        >
          <Folder className="size-3.5 shrink-0" />
          <span className="truncate" dir="auto">
            {folder.name}
          </span>
          <span className="text-muted-foreground/60">/</span>
        </Link>
      ) : null}
      <h1 className="min-w-0 truncate text-[13px] font-medium" dir="auto" title={title}>
        {title}
      </h1>
      {folder && folder.repos.length > 0 ? (
        <div className="hidden min-w-0 shrink items-center gap-1.5 xl:flex">
          {folder.repos.slice(0, HEADER_REPOS).map((repo) => (
            <RepoChip key={repo.fullName} repo={repo} className="max-w-48" />
          ))}
          {extraRepos > 0 ? (
            <Link
              to="/folders/$folderId"
              params={{ folderId: folder.folderId }}
              className="text-muted-foreground hover:text-foreground shrink-0 text-[11px] tabular-nums"
              title={folder.repos.map((repo) => repo.fullName).join('\n')}
            >
              +{extraRepos}
            </Link>
          ) : null}
        </div>
      ) : null}
    </>
  )
}

function ConnectionIndicator({ connection }: { connection: LoomsConnectionStatus }) {
  switch (connection) {
    case 'live':
      return (
        <span className="text-muted-foreground inline-flex items-center gap-1.5 text-[11px]">
          <span className="bg-status-completed size-1.5 rounded-full" />
          Live
        </span>
      )
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

function SessionContext({ feed }: { feed: SessionFeed }) {
  const brief = currentBrief(feed)

  return (
    <div className="flex max-h-[45%] min-h-0 shrink-0 flex-col border-t">
      <ScrollArea className="min-h-0 flex-1">
        {brief ? <BriefCard brief={brief} revisions={feed.brief.length} /> : null}
        {feed.playbook.lessons.length > 0 ? (
          <>
            <SectionLabel>Playbook v{feed.playbook.version}</SectionLabel>
            <ul className="space-y-1.5 px-3 pb-3">
              {feed.playbook.lessons.map((lesson) => (
                <li
                  key={lesson.id}
                  className="text-muted-foreground flex gap-2 text-xs leading-relaxed"
                >
                  <span className="bg-route-constraint mt-1.5 size-1 shrink-0 rounded-full" />
                  {lesson.text}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </ScrollArea>
    </div>
  )
}

function BriefCard({ brief, revisions }: { brief: BriefRevision; revisions: number }) {
  return (
    <section>
      <SectionLabel className="flex items-center gap-1.5">
        <FileText className="size-3" />
        Brief
        <span
          className={cn(
            'ml-auto font-mono text-[10px] tabular-nums',
            revisions > 1 ? 'text-route-idea' : 'text-muted-foreground',
          )}
        >
          v{brief.version}
        </span>
      </SectionLabel>
      <p className="text-foreground/85 px-3 pb-3 text-xs leading-relaxed whitespace-pre-wrap">
        {brief.text}
      </p>
    </section>
  )
}

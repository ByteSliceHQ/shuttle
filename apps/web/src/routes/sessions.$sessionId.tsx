import { createFileRoute, Link } from '@tanstack/react-router'
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Copy,
  Ellipsis,
  Files,
  Folder as FolderIcon,
  GitCompareArrows,
  GitPullRequest,
  Globe,
  Images,
  PanelBottom,
  PanelRight,
  Search,
  SquareTerminal,
  Users,
  X,
} from 'lucide-react'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { AgentTree } from '@/components/agent-tree'
import { ArtifactPane } from '@/components/artifacts/artifact-pane'
import { CommandPalette, type Command } from '@/components/command-palette'
import { Composer } from '@/components/composer'
import { Conversation, type OpenArtifact } from '@/components/conversation'
import { EventStream } from '@/components/event-stream'
import { OpenPullRequestButton } from '@/components/open-pull-request'
import { SessionContextButtons } from '@/components/session-context'
import { SessionPlace } from '@/components/session-place'
import { SessionPrPills } from '@/components/session-pr-pills'
import { SessionRepos } from '@/components/session-repos'
import { SessionShare } from '@/components/session-share'
import { useReportLiveSession, useWorkspace } from '@/components/sidebar/workspace-context'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Kbd, PanelHeader, PanelTitle } from '@/components/ui/panel'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { agentIdentities, withVendorAgents } from '@/lib/agents'
import { fetchSessionHarness, stopThread, type HarnessId } from '@/lib/api'
import { cn, shortId } from '@/lib/cn'
import { possessive, useOrgPeople } from '@/lib/org-people'
import {
  authoredPullsForSession,
  pullInbox,
  reviewedPullForSession,
  usePullsRunId,
  type PullInboxState,
} from '@/lib/pulls'
import { rememberSession } from '@/lib/recent-sessions'
import { sessionActivity } from '@/lib/session-activity'
import {
  sessionFeed,
  vendorLiveFeed,
  withLiveVendorSteps,
  streamingTurns,
  type PublishedPull,
  type SessionFeed,
} from '@/lib/session-feed'
import {
  shortcutLabel,
  useAgentsOpen,
  useArtifactsChoice,
  useCollapsiblePanel,
  useEventsOpen,
  usePaneShortcuts,
  type PaneShortcut,
} from '@/lib/session-panes'
import { statusClass, statusLabel } from '@/lib/status'
import { useTenant } from '@/lib/tenant'
import { threadParents, threadPath } from '@/lib/timeline'
import { useSessionTabs } from '@/lib/use-session-tabs'
import { useWidthBucket } from '@/lib/use-width-bucket'
import type { WorkspaceFolder } from '@/lib/workspace'
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
  /** Agent thread whose own timeline is open in the conversation. */
  readonly view?: string
}

export const Route = createFileRoute('/sessions/$sessionId')({
  validateSearch: (search: Record<string, unknown>): SessionSearch => ({
    ...(typeof search.thread === 'string' && search.thread ? { thread: search.thread } : {}),
    ...(typeof search.view === 'string' && search.view ? { view: search.view } : {}),
  }),
  component: SessionPage,
})

function SessionPage() {
  const { sessionId } = Route.useParams()
  const { thread, view } = Route.useSearch()
  const navigate = Route.useNavigate()

  // The open thread lives in the URL, so a timeline can be linked to and Back leaves it.
  const openThread = useCallback(
    (threadId: string | undefined) => {
      void navigate({ search: (previous) => ({ ...previous, view: threadId }) })
    },
    [navigate],
  )

  return (
    <SessionWorkspace
      key={sessionId}
      runId={sessionId}
      focusThreadId={thread}
      viewParam={view}
      onOpenThread={openThread}
    />
  )
}

/**
 * Session-area widths, in CSS pixels, at which a pane can dock. Below the first only the
 * conversation shows (artifacts open over it); from the second the agents pane can dock too.
 */
const PANE_BREAKPOINTS = [640, 980] as const

type PaneLayout = 'one' | 'two' | 'three'

const AGENTS_SHORTCUT = { key: 'a', shift: true } as const
const ARTIFACTS_SHORTCUT = { key: 'b', shift: true } as const
const EVENTS_SHORTCUT = { key: 'j' } as const
const PALETTE_SHORTCUT = { key: 'k' } as const

function SessionWorkspace({
  runId,
  focusThreadId,
  viewParam,
  onOpenThread,
}: {
  runId: string
  focusThreadId?: string
  viewParam?: string
  onOpenThread: (threadId: string | undefined) => void
}) {
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
  const [layoutRef, paneCount] = useWidthBucket<HTMLDivElement>(PANE_BREAKPOINTS)
  const layout: PaneLayout = paneCount >= 2 ? 'three' : paneCount === 1 ? 'two' : 'one'

  // The default view is the conversation alone. Agents and event history stay closed until
  // asked for; artifacts show once the session has something open in them, unless the reader
  // has opened or closed the pane themself.
  const tabsController = useSessionTabs(runId)
  const [agentsOpen, setAgentsOpen] = useAgentsOpen()
  const [eventsOpen, setEventsOpen] = useEventsOpen()
  const [artifactsChoice, setArtifactsChoice] = useArtifactsChoice(runId)
  const artifactsDocked = artifactsChoice ?? tabsController.tabs.order.length > 0
  // Only read in the one-pane layout, where the artifact pane opens over the conversation.
  const [artifactsOverlay, setArtifactsOverlay] = useState(false)
  const artifactsOpen = layout === 'one' ? artifactsOverlay : artifactsDocked

  const toggleArtifacts = () => {
    if (layout === 'one') {
      setArtifactsOverlay(!artifactsOverlay)
    } else {
      setArtifactsChoice(!artifactsDocked)
    }
  }

  const revealArtifacts = useCallback(() => {
    setArtifactsOverlay(true)
    setArtifactsChoice(true)
  }, [setArtifactsChoice])

  // Opens what a message points at. A preview that is already open comes forward instead of
  // opening a second time.
  const { tabs: sessionTabs, openTab, setActiveTabId } = tabsController

  const openArtifact = useCallback<OpenArtifact>(
    (kind, target) => {
      revealArtifacts()

      const existing =
        kind === 'browser'
          ? Object.values(sessionTabs.tabs).find(
              (tab) => tab.kind === 'browser' && tab.target === target,
            )
          : undefined

      if (existing) {
        setActiveTabId(existing.tabId)
      } else {
        void openTab({ kind, target })
      }
    },
    [revealArtifacts, sessionTabs, openTab, setActiveTabId],
  )

  // A review session is about its review, so that tab is open when the session first is. Once
  // per session and browser: closing the tab afterwards keeps it closed.
  const reviewing = Boolean(
    reviewedPullForSession(useProjection(useRunStore(usePullsRunId()), pullInbox), runId),
  )

  const reviewTabOffered = useRef<string | null>(null)

  useEffect(() => {
    if (!reviewing || reviewTabOffered.current === runId) {
      return
    }

    reviewTabOffered.current = runId

    const key = `shuttle:review-tab-opened:${runId}`

    try {
      if (window.localStorage.getItem(key)) {
        return
      }

      window.localStorage.setItem(key, '1')
    } catch {
      // Storage is unavailable; opening the tab once per visit is the best that can be done.
    }

    // The pane shows itself once it has a tab, unless it was deliberately hidden.
    void openTab({ kind: 'review' })
  }, [reviewing, runId, openTab])

  const [paletteOpen, setPaletteOpen] = useState(false)

  // The conversation shows one timeline at a time: the session's top level, or one agent's.
  // The session's own thread is the top level.
  const viewThreadId = viewParam && viewParam !== tree.root?.threadId ? viewParam : undefined

  // The agents above the open thread, top down, ending with it.
  const viewPath = useMemo(
    () => (viewThreadId ? threadPath(viewThreadId, threadParents(tree.root)) : []),
    [viewThreadId, tree.root],
  )

  const leaveThread = useCallback(() => {
    // One level up. From an agent the top level delegated to, that is the session itself,
    // which already shows the delegating agent's side of the work.
    onOpenThread(viewPath.length > 2 ? viewPath.at(-2) : undefined)
  }, [onOpenThread, viewPath])

  useEffect(() => {
    if (!viewThreadId) {
      return
    }

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target

      // Escape belongs first to whatever is open or being typed into.
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        (target instanceof HTMLElement &&
          (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) ||
        document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')
      ) {
        return
      }

      leaveThread()
    }

    window.addEventListener('keydown', onKeyDown)

    return () => window.removeEventListener('keydown', onKeyDown)
  }, [viewThreadId, leaveThread])

  // Everything the default view keeps out of sight, findable by name.
  const commands: Command[] = [
    ...(layout === 'three'
      ? [
          {
            id: 'agents',
            label: agentsOpen ? 'Hide agents' : 'Show agents',
            icon: <Users />,
            shortcut: shortcutLabel(AGENTS_SHORTCUT),
            keywords: 'threads tree conductor worker',
            run: () => setAgentsOpen(!agentsOpen),
          },
        ]
      : []),
    {
      id: 'artifacts',
      label: artifactsOpen ? 'Hide artifacts' : 'Show artifacts',
      icon: <PanelRight />,
      shortcut: shortcutLabel(ARTIFACTS_SHORTCUT),
      keywords: 'panel tabs side',
      run: toggleArtifacts,
    },
    {
      id: 'events',
      label: eventsOpen ? 'Hide event history' : 'Show event history',
      icon: <PanelBottom />,
      shortcut: shortcutLabel(EVENTS_SHORTCUT),
      keywords: 'debug log inspect',
      run: () => setEventsOpen(!eventsOpen),
    },
    {
      id: 'workspace',
      label: 'Open workspace',
      icon: <Files />,
      keywords: 'files changes diff code',
      run: () => openArtifact('files'),
    },
    {
      id: 'terminal',
      label: 'Open terminal',
      icon: <SquareTerminal />,
      keywords: 'shell console',
      run: () => openArtifact('terminal'),
    },
    {
      id: 'browser',
      label: 'Open browser',
      icon: <Globe />,
      keywords: 'preview web page',
      run: () => openArtifact('browser'),
    },
    {
      id: 'review',
      label: 'Open review',
      icon: <GitCompareArrows />,
      keywords: 'pull request diff',
      run: () => openArtifact('review'),
    },
    {
      id: 'media',
      label: 'Open media',
      icon: <Images />,
      keywords: 'images video audio files attachments assets generated',
      run: () => openArtifact('media'),
    },
    {
      id: 'copy-run-id',
      label: 'Copy run ID',
      icon: <Copy />,
      keywords: 'session identifier',
      run: () => void navigator.clipboard.writeText(runId),
    },
  ]

  const agentsPanel = useCollapsiblePanel({
    open: agentsOpen,
    onOpenChange: setAgentsOpen,
    preferredSize: '18',
  })

  const artifactsPanel = useCollapsiblePanel({
    open: artifactsDocked,
    onOpenChange: setArtifactsChoice,
    preferredSize: '34',
  })

  const eventsPanel = useCollapsiblePanel({
    open: eventsOpen,
    onOpenChange: setEventsOpen,
    preferredSize: '38',
  })

  usePaneShortcuts([
    { ...AGENTS_SHORTCUT, run: () => setAgentsOpen(!agentsOpen) },
    { ...ARTIFACTS_SHORTCUT, run: toggleArtifacts },
    { ...EVENTS_SHORTCUT, run: () => setEventsOpen(!eventsOpen) },
    { ...PALETTE_SHORTCUT, run: () => setPaletteOpen(!paletteOpen) },
  ])

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
  const workspaceTree = useWorkspace()?.tree
  const folderId = workspaceTree?.sessions[runId]?.folderId
  const folder = folderId ? workspaceTree?.folders[folderId] : undefined

  // A finished run says how it ended; a live one says what it is doing now.
  const sessionStatus =
    summary.status === 'completed' || summary.status === 'failed' || summary.status === 'cancelled'
      ? summary.status
      : summary.startedAt !== undefined
        ? activityState.activity
        : 'working'

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

  // Inspecting an agent or one of its steps opens event history on it.
  const inspect = useCallback(
    (threadId: string, seq?: number) => {
      setSelectedThreadId(threadId)
      setSelectedSeq(seq)
      setEventsOpen(true)
    },
    [setEventsOpen],
  )

  const focusThreadKnown = focusThreadId !== undefined && identities.has(focusThreadId)
  const [focusedThreadId, setFocusedThreadId] = useState<string | undefined>()

  if (focusThreadKnown && focusedThreadId !== focusThreadId) {
    setFocusedThreadId(focusThreadId)
    setSelectedThreadId(focusThreadId)
    setSelectedSeq(undefined)
    setEventsOpen(true)
  }

  const artifacts = (
    <ArtifactPane
      runId={runId}
      folderId={folderId}
      events={events}
      media={feed.media}
      identities={identities}
      controller={tabsController}
      onReveal={revealArtifacts}
    />
  )

  return (
    <div ref={layoutRef} className="flex h-full min-h-0 flex-col">
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} commands={commands} />
      <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
        <ResizablePanel id="session" minSize={160}>
          <ResizablePanelGroup orientation="horizontal" className="h-full min-h-0">
            {layout === 'three' ? (
              <>
                <ResizablePanel
                  id="agents"
                  panelRef={agentsPanel.panelRef}
                  onResize={agentsPanel.onResize}
                  defaultSize={agentsPanel.defaultSize}
                  collapsible
                  collapsedSize={0}
                  minSize={200}
                  maxSize="30"
                >
                  <aside
                    inert={!agentsOpen}
                    aria-label="Agents"
                    className="bg-sidebar flex h-full min-h-0 flex-col"
                  >
                    <PanelHeader className="pr-2">
                      <Users className="text-muted-foreground size-3.5" />
                      <PanelTitle meta={identities.size || undefined}>Agents</PanelTitle>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="ml-auto"
                        aria-label="Close agents"
                        onClick={() => setAgentsOpen(false)}
                      >
                        <X />
                      </Button>
                    </PanelHeader>
                    <AgentTree
                      root={tree.root}
                      activityState={activityState}
                      identities={identities}
                      eventCounts={eventCounts}
                      totalEventCount={events.length}
                      selectedThreadId={viewThreadId ?? selectedThreadId}
                      showCounts={eventsOpen}
                      onSelect={(threadId) => {
                        // Picking an agent opens its timeline. Event history, when it is
                        // open, follows along.
                        setSelectedThreadId(threadId)
                        setSelectedSeq(undefined)
                        onOpenThread(threadId)
                      }}
                      onStop={(threadId) => stopThread(runId, threadId)}
                    />
                  </aside>
                </ResizablePanel>
                <ResizableHandle className={agentsOpen ? undefined : 'hidden'} />
              </>
            ) : null}
            <ResizablePanel id="conversation" minSize={layout === 'one' ? 0 : 320}>
              <main className="flex h-full min-h-0 flex-col">
                <SessionTitleBar
                  runId={runId}
                  goal={goalText}
                  folder={folder}
                  connection={summary.connection}
                  feed={feed}
                  labelFor={labelFor}
                  onInspect={inspect}
                  status={sessionStatus}
                  onShowAgents={layout === 'three' ? () => setAgentsOpen(true) : undefined}
                  eventsOpen={eventsOpen}
                  onToggleEvents={() => setEventsOpen(!eventsOpen)}
                  onOpenPalette={() => setPaletteOpen(true)}
                  viewPath={viewPath}
                  onOpenThread={onOpenThread}
                  onLeaveThread={leaveThread}
                  leading={
                    layout === 'three' && !agentsOpen ? (
                      <PaneToggle
                        label="Agents"
                        shortcut={AGENTS_SHORTCUT}
                        open={agentsOpen}
                        onToggle={() => setAgentsOpen(true)}
                        align="start"
                      >
                        <Users />
                      </PaneToggle>
                    ) : null
                  }
                  trailing={
                    <PaneToggle
                      label="Artifacts"
                      shortcut={ARTIFACTS_SHORTCUT}
                      open={artifactsOpen}
                      onToggle={toggleArtifacts}
                    >
                      <PanelRight />
                    </PaneToggle>
                  }
                />
                {/* Artifacts open over this area in the one-pane layout, under the title bar. */}
                <div className="relative flex min-h-0 flex-1 flex-col">
                  <Conversation
                    runId={runId}
                    feed={feed}
                    activity={activityState}
                    streaming={streaming}
                    identities={identities}
                    onInspect={inspect}
                    onOpenArtifact={openArtifact}
                    root={tree.root}
                    openThreadId={viewThreadId}
                    onOpenThread={onOpenThread}
                  />
                  <Composer
                    runId={runId}
                    harness={harness}
                    onHarnessChange={setHarness}
                    identities={identities}
                    disabled={summary.finished}
                    showExamples={!hasInterjected}
                    targetThreadId={viewThreadId}
                    context={
                      <>
                        {folder ? (
                          <SessionRepos
                            folderId={folder.folderId}
                            folderName={folder.name}
                            repos={folder.repos}
                            align="start"
                          />
                        ) : null}
                        <SessionContextButtons feed={feed} />
                      </>
                    }
                  />
                  {layout === 'one' && artifactsOverlay ? (
                    <aside className="bg-background absolute inset-0 z-20 min-h-0">
                      {artifacts}
                    </aside>
                  ) : null}
                </div>
              </main>
            </ResizablePanel>
            {layout === 'one' ? null : (
              <>
                <ResizableHandle className={artifactsDocked ? undefined : 'hidden'} />
                <ResizablePanel
                  id="artifacts"
                  panelRef={artifactsPanel.panelRef}
                  onResize={artifactsPanel.onResize}
                  defaultSize={artifactsPanel.defaultSize}
                  collapsible
                  collapsedSize={0}
                  minSize={280}
                >
                  <aside inert={!artifactsDocked} aria-label="Artifacts" className="h-full min-h-0">
                    {artifacts}
                  </aside>
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
        </ResizablePanel>
        <ResizableHandle
          className={cn(
            'h-px w-full after:inset-x-0 after:inset-y-auto after:top-1/2 after:left-0 after:h-2 after:w-full after:translate-x-0 after:-translate-y-1/2',
            !eventsOpen && 'hidden',
          )}
        />
        <ResizablePanel
          id="events"
          panelRef={eventsPanel.panelRef}
          onResize={eventsPanel.onResize}
          defaultSize={eventsPanel.defaultSize}
          collapsible
          collapsedSize={0}
          minSize={180}
          maxSize="80"
        >
          <section
            inert={!eventsOpen}
            aria-label="Event history"
            className="bg-sidebar h-full min-h-0"
          >
            <EventStream
              events={events}
              startedAt={summary.startedAt}
              threadId={selectedThreadId}
              threadLabel={labelFor(selectedThreadId ?? null)}
              labelFor={labelFor}
              onClearThread={() => setSelectedThreadId(undefined)}
              selectedSeq={selectedSeq}
              onSelectSeq={setSelectedSeq}
              title="Event history"
              split
              onClose={() => setEventsOpen(false)}
            />
          </section>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}

/** A header button that shows or hides one of the session's panes, with its shortcut on hover. */
function PaneToggle({
  label,
  shortcut,
  open,
  onToggle,
  align = 'end',
  children,
}: {
  label: string
  shortcut: Pick<PaneShortcut, 'key' | 'shift'>
  open: boolean
  onToggle: () => void
  align?: 'start' | 'end'
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-pressed={open}
          onClick={onToggle}
          className="aria-pressed:bg-accent aria-pressed:text-foreground"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align={align}>
        <span className="inline-flex items-center gap-1.5">
          {open ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          <Kbd>{shortcutLabel(shortcut)}</Kbd>
        </span>
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * What the session is doing, in the title bar. The bar leaves it out while idle: nothing to
 * report is the resting state, and a badge for it is noise.
 */
function SessionStatusLine({
  status,
  onShowAgents,
}: {
  status: string
  /** Opens the agents pane, where there is room for one. */
  onShowAgents?: () => void
}) {
  const body = (
    <>
      <StatusDot status={status} />
      <span className="hidden @md:inline">{statusLabel(status)}</span>
    </>
  )

  const className = cn(
    'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11.5px] font-medium whitespace-nowrap',
    statusClass(status),
  )

  return onShowAgents ? (
    <button
      type="button"
      onClick={onShowAgents}
      aria-label={`${statusLabel(status)}. Show agents`}
      title={`${statusLabel(status)}. Show agents`}
      className={cn(
        className,
        'ease-snappy transition-[background-color,transform] duration-150 outline-none hover:bg-current/10 focus-visible:bg-current/10 active:scale-[0.97]',
      )}
    >
      {body}
    </button>
  ) : (
    <span className={className} title={statusLabel(status)}>
      {body}
    </span>
  )
}

/**
 * The session's name and what it produced, at the top of the conversation. It has no border and
 * shares the panel header height (and the app sidebar's top bar), so it reads as part of the conversation and lines up with the
 * panes beside it.
 */
function SessionTitleBar({
  runId,
  goal,
  folder,
  connection,
  feed,
  labelFor,
  onInspect,
  status,
  onShowAgents,
  eventsOpen,
  onToggleEvents,
  onOpenPalette,
  viewPath,
  onOpenThread,
  onLeaveThread,
  leading,
  trailing,
}: {
  runId: string
  goal: string | undefined
  folder: WorkspaceFolder | undefined
  connection: LoomsConnectionStatus
  feed: SessionFeed
  labelFor: (threadId: string | null) => string | undefined
  onInspect: (threadId: string) => void
  /** How the run ended, or what it is doing now. Nothing shows for it while idle. */
  status: string
  /** Opens the agents pane, where there is room for one. */
  onShowAgents?: () => void
  eventsOpen: boolean
  onToggleEvents: () => void
  onOpenPalette: () => void
  /** The agents above the open thread, top down, ending with it. Empty at the top level. */
  viewPath: readonly string[]
  onOpenThread: (threadId: string | undefined) => void
  onLeaveThread: () => void
  /** Sits before the title: the control that brings back a closed agents pane. */
  leading?: ReactNode
  /** Sits at the far end: the control that shows or hides the artifacts pane. */
  trailing?: ReactNode
}) {
  const [copied, setCopied] = useState(false)
  const title = useWorkspace()?.tree.sessions[runId]?.title ?? goal ?? 'Coding session'
  const pullsStore = useRunStore(usePullsRunId())
  const inbox = useProjection(pullsStore, pullInbox)

  const sessionPulls = useMemo(
    () => mergeSessionPulls(feed.publishedPulls, inbox, runId),
    [feed.publishedPulls, inbox, runId],
  )

  const reviewed = useMemo(() => reviewedPullForSession(inbox, runId), [inbox, runId])

  // The title only ever truncates, so its length never moves the controls. As the bar narrows
  // the folder goes first, then the status and connection labels, then all but one avatar. The
  // title, the menu and the artifacts toggle stay to the end.
  return (
    <header className="@container grid h-12 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-2">
      <div className="flex min-w-0 items-center gap-1.5">
        {leading}
        <div className="flex min-w-0 items-center gap-1.5 pl-1">
          {folder ? (
            <>
              <Link
                to="/folders/$folderId"
                params={{ folderId: folder.folderId }}
                title={folder.name}
                className="text-muted-foreground hover:text-foreground hidden max-w-24 shrink-0 items-center gap-1.5 text-[12px] transition-colors duration-100 @xl:inline-flex @4xl:max-w-40"
              >
                <FolderIcon className="size-3.5 shrink-0" />
                <span className="truncate" dir="auto">
                  {folder.name}
                </span>
              </Link>
              <span aria-hidden className="text-muted-foreground/50 hidden text-[12px] @xl:inline">
                /
              </span>
            </>
          ) : null}
          {viewPath.length === 0 ? (
            <h1 className="min-w-0 truncate text-[13px] font-medium" dir="auto" title={title}>
              {title}
            </h1>
          ) : (
            <ThreadBreadcrumb
              title={title}
              path={viewPath}
              labelFor={labelFor}
              onOpenThread={onOpenThread}
              onLeave={onLeaveThread}
            />
          )}
        </div>
      </div>
      <div className="flex items-center gap-0.5">
        {reviewed ? (
          <a
            href={reviewed.url}
            target="_blank"
            rel="noreferrer"
            title={`Reviewing ${reviewed.fullName}#${reviewed.number}: ${reviewed.title}\n${reviewed.headRef} → ${reviewed.baseRef}`}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex max-w-52 shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-colors duration-100 outline-none focus-visible:ring-2"
          >
            <GitPullRequest className="size-3 shrink-0" />
            <span className="min-w-0 truncate">
              Reviewing <span className="font-mono">#{reviewed.number}</span>
            </span>
          </a>
        ) : null}
        <SessionPrPills pulls={sessionPulls} labelFor={labelFor} onInspect={onInspect} />
        {folder && folder.repos.length > 0 && !reviewed ? (
          <OpenPullRequestButton
            runId={runId}
            feed={feed}
            hasPulls={sessionPulls.length > 0}
            working={status === 'working' || status === 'running'}
          />
        ) : null}
        <ConnectionIndicator connection={connection} />
        {status === 'idle' ? null : (
          <SessionStatusLine status={status} onShowAgents={onShowAgents} />
        )}
        <SessionPlace
          key={`place:${runId}`}
          runId={runId}
          working={status === 'working' || status === 'running'}
        />
        <SessionShare key={runId} runId={runId} />
        <DropdownMenu onOpenChange={(open) => !open && setCopied(false)}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="More session actions">
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem onSelect={onOpenPalette}>
              <Search />
              Commands
              <Kbd className="ml-auto">{shortcutLabel(PALETTE_SHORTCUT)}</Kbd>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onToggleEvents}>
              <PanelBottom />
              {eventsOpen ? 'Hide event history' : 'Show event history'}
              <Kbd className="ml-auto">{shortcutLabel(EVENTS_SHORTCUT)}</Kbd>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={(event) => {
                // Stay open long enough to show that it copied.
                event.preventDefault()
                void navigator.clipboard.writeText(runId).then(() => setCopied(true))
              }}
            >
              {copied ? <Check className="text-status-completed" /> : <Copy />}
              {copied ? 'Copied' : 'Copy run ID'}
              <span className="text-muted-foreground ml-auto font-mono text-[10px]">
                {shortId(runId)}
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {trailing}
      </div>
    </header>
  )
}

/**
 * Where the open timeline sits: the session, the agents above it, then the agent itself. Each
 * step but the last goes back to that level.
 */
function ThreadBreadcrumb({
  title,
  path,
  labelFor,
  onOpenThread,
  onLeave,
}: {
  title: string
  path: readonly string[]
  labelFor: (threadId: string | null) => string | undefined
  onOpenThread: (threadId: string | undefined) => void
  onLeave: () => void
}) {
  const crumbClass =
    'text-muted-foreground hover:text-foreground min-w-0 truncate text-[13px] transition-colors duration-100'

  return (
    <nav aria-label="Open thread" className="flex min-w-0 items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Back" onClick={onLeave}>
            <ArrowLeft />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start">
          <span className="inline-flex items-center gap-1.5">
            Back <Kbd>Esc</Kbd>
          </span>
        </TooltipContent>
      </Tooltip>
      <button
        type="button"
        onClick={() => onOpenThread(undefined)}
        title={title}
        dir="auto"
        className={cn(crumbClass, 'hidden max-w-48 shrink @lg:block')}
      >
        {title}
      </button>
      {path.map((threadId, index) => {
        const last = index === path.length - 1
        const label = labelFor(threadId) ?? 'Agent'

        return (
          <Fragment key={threadId}>
            <ChevronRight
              aria-hidden
              className={cn(
                'text-muted-foreground/60 size-3 shrink-0',
                // The first separator follows the title, which is hidden where space is short.
                index === 0 && 'hidden @lg:block',
                !last && index > 0 && 'hidden @2xl:block',
              )}
            />
            {last ? (
              <h1 className="min-w-0 truncate text-[13px] font-medium">{label}</h1>
            ) : (
              <button
                type="button"
                onClick={() => onOpenThread(threadId)}
                className={cn(crumbClass, 'hidden shrink-0 @2xl:block')}
              >
                {label}
              </button>
            )}
          </Fragment>
        )
      })}
    </nav>
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
        <span
          title={connection === 'connecting' ? 'Connecting' : 'Reconnecting'}
          className="text-status-waiting inline-flex shrink-0 items-center gap-1.5 px-1 text-[11px]"
        >
          <span className="bg-status-waiting size-1.5 animate-pulse rounded-full" />
          <span className="hidden @md:inline">
            {connection === 'connecting' ? 'Connecting' : 'Reconnecting'}
          </span>
        </span>
      )

    default: {
      const exhaustive: never = connection
      return exhaustive
    }
  }
}

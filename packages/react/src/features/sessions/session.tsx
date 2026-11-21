import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import type { ThreadNode } from '@swirls/looms/core'
import {
  useEventCounts,
  useLiveFold,
  useProjection,
  useRunEvents,
  useRunStore,
  useRunSummary,
  useThreadTree,
  type RunSummary,
} from '@swirls/looms/react'

import {
  capabilitiesQuery,
  possessive,
  useOrgPeople,
  useShuttleHost,
  useTenant,
} from '../../shuttle'
import {
  defaultArtifactTypes,
  servedArtifactTypes,
  type ArtifactType,
} from '../artifacts/artifact-types'
import type { SessionEvent } from '../events/event-catalog'
import { pullInbox, reviewedPullForSession, usePullsRunId } from '../pulls/pulls'
import type { ArtifactTabKind, WorkspaceFolder } from '../workspace/workspace'
import { useOptionalWorkspace, useReportLiveSession } from '../workspace/workspace-context'
import { agentIdentities, withVendorAgents, type AgentIdentity } from './agents'
import { rememberSession } from './recent-sessions'
import { sessionActivity, type SessionActivityState } from './session-activity'
import {
  sessionFeed,
  streamingTurns,
  vendorLiveFeed,
  withLiveVendorSteps,
  type SessionFeed,
  type StreamingTurn,
} from './session-feed'
import { useAgentsOpen, useArtifactsChoice, useEventsOpen } from './session-panes'
import { sessionQueries } from './session-queries'
import { threadParents, threadPath } from './timeline'
import { useSessionTabs, type SessionTabsController } from './use-session-tabs'

/**
 * One session, as everything that shows a part of it reads it. `<Shuttle.Session>` follows the
 * run and folds it once; the parts under it (conversation, composer, agents, artifacts, event
 * history, header) each take what they need from here, so they can be put anywhere, left out,
 * or replaced with something that reads the same thing.
 */
export interface SessionValue {
  readonly runId: string
  /** The session's name: the one it was given, else what it was asked to do. */
  readonly title: string
  /** What the session was first asked to do. */
  readonly goal: string | undefined
  /** How the run ended, or what it is doing now. */
  readonly status: string
  readonly summary: RunSummary
  /** The folder the session is in, where what hosts it keeps folders. */
  readonly folder: WorkspaceFolder | undefined

  /** The conversation, folded from the run's events. */
  readonly feed: SessionFeed
  readonly activity: SessionActivityState
  /** The turns agents are writing right now, by thread. */
  readonly streaming: Readonly<Record<string, StreamingTurn>>
  readonly events: readonly SessionEvent[]
  readonly eventCounts: ReadonlyMap<string, number>
  /** The session's agents, as a tree of threads. */
  readonly root: ThreadNode | null
  readonly identities: ReadonlyMap<string, AgentIdentity>
  readonly labelFor: (threadId: string | null) => string | undefined

  /** The agent whose own timeline is open. Undefined at the session's top level. */
  readonly openThreadId: string | undefined
  /** The agents above the open thread, top down, ending with it. Empty at the top level. */
  readonly threadPath: readonly string[]
  readonly openThread: (threadId: string | undefined) => void
  /** Goes up one level from the open thread. */
  readonly leaveThread: () => void

  /** What event history is looking at: one agent's events, and one event among them. */
  readonly inspected: { readonly threadId: string | undefined; readonly seq: number | undefined }
  readonly selectThread: (threadId: string | undefined) => void
  readonly selectEvent: (seq: number | undefined) => void
  /** Opens event history on an agent, or on one of its steps. */
  readonly inspect: (threadId: string, seq?: number) => void

  /** The kinds of tab the artifacts pane can show: the ones given, less what the backend cannot serve. */
  readonly artifactTypes: readonly ArtifactType[]
  /** Whether the session is only being watched: nothing in it sends, decides or answers. */
  readonly readOnly: boolean
  readonly tabs: SessionTabsController
  /** Shows something in the artifacts pane, bringing the pane out if it is away. */
  readonly openArtifact: (kind: ArtifactTabKind, target?: string) => void

  /**
   * Which panes the reader wants out. These are wishes, not layout: an arrangement decides
   * what it does with each, and one that has no such pane ignores it.
   */
  readonly panes: {
    readonly agents: boolean
    readonly setAgents: (open: boolean) => void
    readonly events: boolean
    readonly setEvents: (open: boolean) => void
    /** Beside the conversation. Follows whether anything is open in it until the reader says. */
    readonly artifacts: boolean
    readonly setArtifacts: (open: boolean) => void
    /** Over the conversation, where there is no room beside it. */
    readonly artifactsOverlay: boolean
    readonly setArtifactsOverlay: (open: boolean) => void
    /** Brings the artifacts pane out, wherever the arrangement shows it. */
    readonly revealArtifacts: () => void
    readonly palette: boolean
    readonly setPalette: (open: boolean) => void
  }
}

const SessionContext = createContext<SessionValue | null>(null)

/** The session the nearest `<Shuttle.Session>` is following. */
export function useSession(): SessionValue {
  const value = useContext(SessionContext)

  if (!value) {
    throw new Error('Session parts must be used inside <Shuttle.Session>')
  }

  return value
}

export interface SessionProps {
  /** The session's run. */
  readonly id: string
  /**
   * The agent whose own timeline is open. Pass it with `onThreadChange` to keep it somewhere
   * of the host's, such as the address, so a timeline can be linked to and Back leaves it.
   * Without `onThreadChange` the session keeps it itself.
   */
  readonly thread?: string | undefined
  readonly onThreadChange?: (threadId: string | undefined) => void
  /** An agent to open event history on when the session first shows, such as a link's. */
  readonly focusThread?: string | undefined
  /** The kinds of tab the artifacts pane can show. Shuttle's own, unless given others. */
  readonly artifactTypes?: readonly ArtifactType[]
  /**
   * Shows the session without the means to change it: no message box, and its questions and
   * proposals cannot be answered here. For a page that watches a session someone else, or
   * something else, is driving.
   */
  readonly readOnly?: boolean
  readonly children: ReactNode
}

/**
 * Follows one session and gives it to the parts inside. The session's run should already be
 * synced and its queries read (see the session page's loader) for it to arrive whole.
 */
export function Session(props: SessionProps) {
  // Everything kept here is about one session, so another session starts afresh.
  return <SessionRoot key={props.id} {...props} />
}

function SessionRoot({
  id: runId,
  thread,
  onThreadChange,
  focusThread,
  artifactTypes: givenArtifactTypes = defaultArtifactTypes,
  readOnly = false,
  children,
}: SessionProps) {
  const host = useShuttleHost()

  // What the backend serves is asked once. Until it answers, nothing is left out.
  const { data: capabilities = null } = useQuery(capabilitiesQuery(host))

  const artifactTypes = useMemo(
    () => servedArtifactTypes(givenArtifactTypes, capabilities),
    [givenArtifactTypes, capabilities],
  )

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

  const activity = useProjection(store, sessionActivity)
  const streaming = useLiveFold(store, streamingTurns)
  const reportLiveSession = useReportLiveSession()

  const [selectedThreadId, setSelectedThreadId] = useState<string | undefined>()
  const [selectedSeq, setSelectedSeq] = useState<number | undefined>()

  // The default view is the conversation alone. Agents and event history stay closed until
  // asked for; artifacts show once the session has something open in them, unless the reader
  // has opened or closed the pane themself.
  const tabs = useSessionTabs(runId, artifactTypes)
  const [agentsOpen, setAgentsOpen] = useAgentsOpen()
  const [eventsOpen, setEventsOpen] = useEventsOpen()
  const [artifactsChoice, setArtifactsChoice] = useArtifactsChoice(runId)
  const artifactsDocked = artifactsChoice ?? tabs.tabs.order.length > 0
  const [artifactsOverlay, setArtifactsOverlay] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)

  const revealArtifacts = useCallback(() => {
    setArtifactsOverlay(true)
    setArtifactsChoice(true)
  }, [setArtifactsChoice])

  // Opens what a message points at. A preview that is already open comes forward instead of
  // opening a second time.
  const { tabs: tabSet, openTab, setActiveTabId } = tabs

  const openArtifact = useCallback(
    (kind: ArtifactTabKind, target?: string) => {
      revealArtifacts()

      const existing =
        kind === 'browser'
          ? Object.values(tabSet.tabs).find(
              (tab) => tab.kind === 'browser' && tab.target === target,
            )
          : undefined

      if (existing) {
        setActiveTabId(existing.tabId)
      } else {
        void openTab({ kind, target })
      }
    },
    [revealArtifacts, tabSet, openTab, setActiveTabId],
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
      if (window.localStorage.getItem(key) !== null) {
        return
      }

      window.localStorage.setItem(key, '1')
    } catch {
      // Storage is unavailable; opening the tab once per visit is the best that can be done.
    }

    // The pane shows itself once it has a tab, unless it was deliberately hidden.
    void openTab({ kind: 'review' })
  }, [reviewing, runId, openTab])

  // The open timeline is the host's to keep when it asks to hear of changes, and otherwise ours.
  const [ownThread, setOwnThread] = useState<string | undefined>()
  const wantedThread = onThreadChange ? thread : ownThread
  const openThread = onThreadChange ?? setOwnThread

  // The conversation shows one timeline at a time: the session's top level, or one agent's.
  // The session's own thread is the top level.
  const openThreadId =
    wantedThread !== undefined && wantedThread !== tree.root?.threadId ? wantedThread : undefined

  const path = useMemo(
    () => (openThreadId !== undefined ? threadPath(openThreadId, threadParents(tree.root)) : []),
    [openThreadId, tree.root],
  )

  const leaveThread = useCallback(() => {
    // One level up. From an agent the top level delegated to, that is the session itself,
    // which already shows the delegating agent's side of the work.
    openThread(path.length > 2 ? path.at(-2) : undefined)
  }, [openThread, path])

  useEffect(() => {
    if (openThreadId === undefined) {
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
  }, [openThreadId, leaveThread])

  // Which agent runs the session is known before its first step, so the thread carries the
  // agent's name from the start and never shows as Shuttle's conductor first. The composer's
  // agent picker writes to the same query, so a change there renames the thread at once.
  const { harness } = useSuspenseQuery(sessionQueries(host, runId).harness).data

  const me = useTenant().user.id
  const people = useOrgPeople()

  const identities = useMemo(
    () =>
      withVendorAgents(agentIdentities(tree.root), feed.vendorAgents, harness, (userId) =>
        possessive(userId, me, people),
      ),
    [tree.root, feed.vendorAgents, harness, me, people],
  )

  const firstMessage = feed.items.find((item) => item.kind === 'user' && item.goal)
  const goal = firstMessage?.kind === 'user' ? firstMessage.text : undefined
  const workspaceTree = useOptionalWorkspace()?.tree
  const listed = workspaceTree?.sessions[runId]

  const folder =
    listed?.folderId === undefined ? undefined : workspaceTree?.folders[listed.folderId]

  const title = listed?.title ?? goal ?? 'Coding session'

  // A finished run says how it ended; a live one says what it is doing now.
  const status =
    summary.status === 'completed' || summary.status === 'failed' || summary.status === 'cancelled'
      ? summary.status
      : summary.startedAt !== undefined
        ? activity.activity
        : 'working'

  useEffect(() => {
    if (goal !== undefined && goal !== '') {
      rememberSession({ runId, goal })
    }
  }, [runId, goal])

  useEffect(() => {
    if (summary.startedAt !== undefined) {
      reportLiveSession(runId, { status: summary.status, activity: activity.activity })
    }
  }, [runId, summary.startedAt, summary.status, activity.activity, reportLiveSession])

  const labelFor = useCallback(
    (threadId: string | null) => (threadId !== null ? identities.get(threadId)?.label : undefined),
    [identities],
  )

  const inspect = useCallback(
    (threadId: string, seq?: number) => {
      setSelectedThreadId(threadId)
      setSelectedSeq(seq)
      setEventsOpen(true)
    },
    [setEventsOpen],
  )

  const focusThreadKnown = focusThread !== undefined && identities.has(focusThread)
  const [focusedThreadId, setFocusedThreadId] = useState<string | undefined>()

  if (focusThreadKnown && focusedThreadId !== focusThread) {
    setFocusedThreadId(focusThread)
    setSelectedThreadId(focusThread)
    setSelectedSeq(undefined)
    setEventsOpen(true)
  }

  const value: SessionValue = {
    runId,
    title,
    goal,
    status,
    summary,
    folder,
    feed,
    activity,
    streaming,
    events,
    eventCounts,
    root: tree.root,
    identities,
    labelFor,
    openThreadId,
    threadPath: path,
    openThread,
    leaveThread,
    inspected: { threadId: selectedThreadId, seq: selectedSeq },
    selectThread: setSelectedThreadId,
    selectEvent: setSelectedSeq,
    inspect,
    artifactTypes,
    readOnly,
    tabs,
    openArtifact,
    panes: {
      agents: agentsOpen,
      setAgents: setAgentsOpen,
      events: eventsOpen,
      setEvents: setEventsOpen,
      artifacts: artifactsDocked,
      setArtifacts: setArtifactsChoice,
      artifactsOverlay,
      setArtifactsOverlay,
      revealArtifacts,
      palette: paletteOpen,
      setPalette: setPaletteOpen,
    },
  }

  return <SessionContext value={value}>{children}</SessionContext>
}

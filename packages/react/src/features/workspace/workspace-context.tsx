import { useSuspenseQuery } from '@tanstack/react-query'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

import { useRunEvents, useRunStore, useRunSummary } from '@swirls/looms/react'

import { useApi } from '../../shuttle'
import type { SessionActivity } from '../sessions/session-activity'
import {
  emptySessionTabs,
  emptyWorkspaceTree,
  sessionTabs,
  workspaceTree,
  type SessionTabsState,
  type WorkspaceSession,
  type WorkspaceSnapshot,
  type WorkspaceTree,
} from './workspace'
import { FIXTURE_MODES, workspaceFixture, type FixtureMode } from './workspace-fixtures'

export interface LiveSessionStatus {
  readonly status: string
  readonly activity: SessionActivity
}

export interface WorkspaceValue {
  /** The organization's workspace run, which holds the folders. */
  readonly runId: string
  /** Both workspaces merged: every folder, and every session this person can see. */
  readonly tree: WorkspaceTree
  readonly tabs: SessionTabsState
  readonly liveSessions: Readonly<Record<string, LiveSessionStatus>>
  /** The workspace run that lists a session, and so keeps its tabs. */
  readonly listingRunId: (sessionRunId: string) => string
}

interface WorkspaceState {
  readonly workspace: WorkspaceValue
  readonly fixtureMode: FixtureMode
  readonly setFixtureMode: (mode: FixtureMode) => void
  readonly setLiveSessionStatus: (runId: string, live: LiveSessionStatus) => void
}

const WorkspaceContext = createContext<WorkspaceState | null>(null)

const FIXTURE_KEY = 'shuttle.fixture'

function initialFixtureMode(): FixtureMode {
  if (!import.meta.env.DEV) {
    return 'live'
  }

  const requested =
    new URLSearchParams(window.location.search).get('data') ?? sessionStorage.getItem(FIXTURE_KEY)

  return FIXTURE_MODES.find((mode) => mode === requested) ?? 'live'
}

function mergeLiveSessions(
  tree: WorkspaceTree,
  liveSessions: Readonly<Record<string, LiveSessionStatus>>,
): WorkspaceTree {
  const entries = Object.entries(liveSessions)

  if (entries.length === 0) {
    return tree
  }

  let changed = false
  const sessions: Record<string, WorkspaceSession> = { ...tree.sessions }

  for (const [sessionRunId, live] of entries) {
    const existing = sessions[sessionRunId]

    if (!existing) {
      continue
    }

    const nextStatus =
      live.status === 'completed' || live.status === 'failed' || live.status === 'cancelled'
        ? live.status
        : existing.status === 'requested'
          ? 'running'
          : existing.status

    if (existing.activity !== live.activity || existing.status !== nextStatus) {
      changed = true

      sessions[sessionRunId] = {
        ...existing,
        status: nextStatus,
        activity: live.activity,
      }
    }
  }

  return changed ? { ...tree, sessions } : tree
}

interface WorkspaceSeed {
  readonly tail: number
  readonly tree: WorkspaceTree
  readonly tabs: SessionTabsState
}

/**
 * One workspace run the page follows: its snapshot, then the live tree and tabs folded from it.
 * The tree is null only when the Worker could not read the workspace and the run's own events
 * have not arrived yet.
 */
function useWorkspaceSource(snapshot: WorkspaceSnapshot) {
  const seed = useMemo<WorkspaceSeed | null>(
    () =>
      snapshot.tree
        ? { tail: snapshot.tail, tree: snapshot.tree, tabs: snapshot.tabs ?? emptySessionTabs }
        : null,
    [snapshot],
  )

  // What the event stream has folded so far. Until it reports, the snapshot is what there is.
  const [tree, setTree] = useState<WorkspaceTree | null>(null)
  const [tabs, setTabs] = useState<SessionTabsState | null>(null)

  return {
    runId: snapshot.runId,
    seed,
    tree: tree ?? seed?.tree ?? null,
    tabs: tabs ?? seed?.tabs ?? emptySessionTabs,
    setTree,
    setTabs,
  }
}

/**
 * Follows the two workspaces a person sees and shows them as one: the organization's, with its
 * folders and public sessions, and their own, with the sessions private to them or shared with
 * them.
 *
 * Each hydrates from the server's authoritative `/workspace` projection snapshot (which preserves
 * server-only fields like `idempotencyKey` and avoids replaying the entire historical log),
 * then folds live delta events strictly past `tail`.
 */
export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const api = useApi()

  // The signed-in layout's loader read the snapshot before this rendered. It is only where the
  // event stream starts from, and the stream keeps it current from then on, so it is never read
  // again for being old. If something does read it again, the fold starts over from the new one.
  const { data: snapshot } = useSuspenseQuery(
    api.workspace.get.queryOptions({ staleTime: Infinity }),
  )

  const shared = useWorkspaceSource(snapshot)
  const personal = useWorkspaceSource(snapshot.personal)
  const [liveSessions, setLiveSessions] = useState<Readonly<Record<string, LiveSessionStatus>>>({})
  const [stalled, setStalled] = useState<string | null>(null)
  const [fixture, setFixture] = useState(() => ({ mode: initialFixtureMode(), at: Date.now() }))
  const fixtureMode = fixture.mode

  const setLiveSessionStatus = useCallback((sessionRunId: string, next: LiveSessionStatus) => {
    setLiveSessions((prev) => {
      const current = prev[sessionRunId]

      if (current && current.activity === next.activity && current.status === next.status) {
        return prev
      }

      return { ...prev, [sessionRunId]: next }
    })
  }, [])

  const fixtureTree = useMemo(
    () =>
      import.meta.env.DEV && fixture.mode !== 'live'
        ? workspaceFixture(fixture.mode, fixture.at)
        : null,
    [fixture],
  )

  const sharedTree = shared.tree
  const personalTree = personal.tree

  const tree = useMemo(() => {
    if (fixtureTree) {
      return fixtureTree
    }

    if (!sharedTree) {
      return null
    }

    return mergeLiveSessions(
      { ...sharedTree, sessions: { ...sharedTree.sessions, ...personalTree?.sessions } },
      liveSessions,
    )
  }, [fixtureTree, sharedTree, personalTree, liveSessions])

  const tabs = useMemo(() => ({ ...shared.tabs, ...personal.tabs }), [shared.tabs, personal.tabs])
  const sharedRunId = shared.runId
  const personalRunId = personal.runId

  const value = useMemo<WorkspaceState | null>(
    () =>
      tree
        ? {
            workspace: {
              runId: sharedRunId,
              tree,
              tabs,
              liveSessions,
              listingRunId: (sessionRunId) =>
                personalTree?.sessions[sessionRunId] ? personalRunId : sharedRunId,
            },
            fixtureMode,
            setFixtureMode(mode) {
              sessionStorage.setItem(FIXTURE_KEY, mode)
              setFixture({ mode, at: Date.now() })
            },
            setLiveSessionStatus,
          }
        : null,
    [
      sharedRunId,
      personalRunId,
      personalTree,
      tree,
      tabs,
      liveSessions,
      fixtureMode,
      setLiveSessionStatus,
    ],
  )

  return (
    <>
      <WorkspaceSubscription
        key={sharedRunId}
        runId={sharedRunId}
        seed={shared.seed}
        onTree={shared.setTree}
        onTabs={shared.setTabs}
        onStalled={setStalled}
      />
      <WorkspaceSubscription
        key={personalRunId}
        runId={personalRunId}
        seed={personal.seed}
        onTree={personal.setTree}
        onTabs={personal.setTabs}
        onStalled={setStalled}
      />
      {value ? (
        <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
      ) : (
        // The Worker answered but could not read the workspace, so there is nothing to show
        // until the run's own events arrive, or it turns out the run was never started.
        <div className="text-muted-foreground flex h-dvh items-center justify-center px-6 text-center text-sm">
          {stalled ?? 'Loading workspace…'}
        </div>
      )}
    </>
  )
}

const STALL_MS = 3000

function WorkspaceSubscription({
  runId,
  seed,
  onTree,
  onTabs,
  onStalled,
}: {
  runId: string
  seed: WorkspaceSeed | null
  onTree: (tree: WorkspaceTree) => void
  onTabs: (tabs: SessionTabsState) => void
  onStalled: (message: string) => void
}) {
  // The snapshot covers the log up to its tail, so only what follows is downloaded. The first
  // snapshot decides where: a later one folds from the same events, without connecting again.
  const [fromSeq] = useState(() => (seed ? seed.tail + 1 : undefined))
  const store = useRunStore(runId, { includeEphemeral: false, fromSeq })

  const events = useRunEvents(store)
  const summary = useRunSummary(store)
  const hydrated = Boolean(seed) || summary.startedAt !== undefined
  const live = summary.connection === 'live'

  const foldRef = useRef<{
    cursor: number
    tree: WorkspaceTree
    tabs: SessionTabsState
    seededTail: number | null
  }>({
    cursor: 0,
    tree: emptyWorkspaceTree,
    tabs: emptySessionTabs,
    seededTail: null,
  })

  useEffect(() => {
    if (!hydrated) {
      return
    }

    const baseTail = seed?.tail ?? null

    if (foldRef.current.seededTail !== baseTail) {
      foldRef.current = {
        cursor: seed?.tail ?? 0,
        tree: seed?.tree ?? emptyWorkspaceTree,
        tabs: seed?.tabs ?? emptySessionTabs,
        seededTail: baseTail,
      }
    }

    let { cursor, tree, tabs } = foldRef.current
    let changed = false

    for (const event of events) {
      if (event.ephemeral || event.seq <= cursor) {
        continue
      }

      cursor = event.seq
      const nextTree = workspaceTree.reduce(tree, event)
      const nextTabs = sessionTabs.reduce(tabs, event)

      if (nextTree !== tree || nextTabs !== tabs) {
        changed = true
      }

      tree = nextTree
      tabs = nextTabs
    }

    foldRef.current = {
      cursor,
      tree,
      tabs,
      seededTail: baseTail,
    }

    if (changed || cursor === (seed?.tail ?? 0)) {
      onTree(tree)
      onTabs(tabs)
    }
  }, [events, hydrated, seed, onTree, onTabs])

  useEffect(() => {
    if (hydrated || !live) {
      return
    }

    const timer = window.setTimeout(
      () => onStalled(`Workspace run "${runId}" is connected but was never started.`),
      STALL_MS,
    )

    return () => window.clearTimeout(timer)
  }, [hydrated, live, runId, onStalled])

  return null
}

function useWorkspaceState(): WorkspaceState {
  const state = useContext(WorkspaceContext)

  if (!state) {
    throw new Error('useWorkspace must be used inside WorkspaceProvider')
  }

  return state
}

/**
 * The workspace run and its folder tree. The signed-in layout's loader reads the snapshot before
 * anything under it renders, so there is always one.
 */
export function useWorkspace(): WorkspaceValue {
  return useWorkspaceState().workspace
}

/**
 * The same, or null where nothing above keeps a workspace. A session shown on its own, in a
 * host that has no folders, is still a whole session: it only has no folder to name and keeps
 * its open tabs to itself.
 */
export function useOptionalWorkspace(): WorkspaceValue | null {
  return useContext(WorkspaceContext)?.workspace ?? null
}

export function useFixtureMode(): [FixtureMode, (mode: FixtureMode) => void] {
  const state = useWorkspaceState()
  return [state.fixtureMode, state.setFixtureMode]
}

export function useReportLiveSession(): (runId: string, live: LiveSessionStatus) => void {
  const state = useContext(WorkspaceContext)
  return useCallback(
    (runId: string, live: LiveSessionStatus) => {
      state?.setLiveSessionStatus(runId, live)
    },
    [state],
  )
}

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

import type { SessionActivity } from '@/lib/session-activity'
import {
  emptySessionTabs,
  emptyWorkspaceTree,
  fetchWorkspace,
  sessionTabs,
  workspaceTree,
  type SessionTabsState,
  type WorkspaceSession,
  type WorkspaceTree,
} from '@/lib/workspace'
import { FIXTURE_MODES, workspaceFixture, type FixtureMode } from '@/lib/workspace-fixtures'
import { useRunEvents, useRunStore, useRunSummary } from '@swirls/looms/react'

export interface LiveSessionStatus {
  readonly status: string
  readonly activity: SessionActivity
}

export interface WorkspaceValue {
  readonly runId: string
  readonly tree: WorkspaceTree
  readonly tabs: SessionTabsState
  readonly liveSessions: Readonly<Record<string, LiveSessionStatus>>
}

interface WorkspaceState {
  readonly workspace: WorkspaceValue | null
  readonly error: string | null
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

/**
 * Hydrates from the server's authoritative `/workspace` projection snapshot (which preserves
 * server-only fields like `idempotencyKey` and avoids replaying the entire historical log),
 * then folds live delta events strictly past `tail`.
 */
export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [runId, setRunId] = useState<string | null>(null)

  const [seed, setSeed] = useState<{
    readonly tail: number
    readonly tree: WorkspaceTree
    readonly tabs: SessionTabsState
  } | null>(null)

  const [liveTree, setLiveTree] = useState<WorkspaceTree | null>(null)
  const [liveTabs, setLiveTabs] = useState<SessionTabsState>({})
  const [liveSessions, setLiveSessions] = useState<Readonly<Record<string, LiveSessionStatus>>>({})
  const [error, setError] = useState<string | null>(null)
  const [fixture, setFixture] = useState(() => ({ mode: initialFixtureMode(), at: Date.now() }))
  const fixtureMode = fixture.mode

  useEffect(() => {
    void fetchWorkspace()
      .then((result) => {
        setRunId(result.runId)

        if (result.tree) {
          const initialTabs = result.tabs ?? emptySessionTabs

          setSeed({
            tail: typeof result.tail === 'number' ? result.tail : 0,
            tree: result.tree,
            tabs: initialTabs,
          })

          setLiveTree(result.tree)
          setLiveTabs(initialTabs)
        }
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : 'Failed to load workspace'),
      )
  }, [])

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

  const tree = useMemo(() => {
    if (fixtureTree) {
      return fixtureTree
    }

    return liveTree ? mergeLiveSessions(liveTree, liveSessions) : null
  }, [fixtureTree, liveTree, liveSessions])

  const value = useMemo<WorkspaceState>(
    () => ({
      workspace: runId && tree ? { runId, tree, tabs: liveTabs, liveSessions } : null,
      error: tree ? null : error,
      fixtureMode,
      setFixtureMode(mode) {
        sessionStorage.setItem(FIXTURE_KEY, mode)
        setFixture({ mode, at: Date.now() })
      },
      setLiveSessionStatus,
    }),
    [runId, tree, liveTabs, liveSessions, error, fixtureMode, setLiveSessionStatus],
  )

  return (
    <WorkspaceContext.Provider value={value}>
      {runId ? (
        <WorkspaceSubscription
          runId={runId}
          seed={seed}
          onTree={setLiveTree}
          onTabs={setLiveTabs}
          onStalled={setError}
        />
      ) : null}
      {children}
    </WorkspaceContext.Provider>
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
  seed: {
    readonly tail: number
    readonly tree: WorkspaceTree
    readonly tabs: SessionTabsState
  } | null
  onTree: (tree: WorkspaceTree) => void
  onTabs: (tabs: SessionTabsState) => void
  onStalled: (message: string) => void
}) {
  const store = useRunStore(runId, { includeEphemeral: false })
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

/** The workspace run and its folder tree, or null while the run id loads. */
export function useWorkspace(): WorkspaceValue | null {
  return useWorkspaceState().workspace
}

export function useWorkspaceError(): string | null {
  return useWorkspaceState().error
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

export function WorkspacePending({ label }: { label: string }) {
  const error = useWorkspaceError()

  return (
    <div className="text-muted-foreground flex h-full items-center justify-center px-6 text-center text-sm">
      {error ?? label}
    </div>
  )
}

import { createContext, useContext, useEffect, useMemo, useState } from 'react'

import {
  fetchWorkspace,
  sessionTabs,
  workspaceTree,
  type SessionTabsState,
  type WorkspaceTree,
} from '@/lib/workspace'
import { FIXTURE_MODES, workspaceFixture, type FixtureMode } from '@/lib/workspace-fixtures'
import { useProjection, useRunStore, useRunSummary } from '@swirls/looms/react'

export interface WorkspaceValue {
  readonly runId: string
  readonly tree: WorkspaceTree
  readonly tabs: SessionTabsState
}

interface WorkspaceState {
  readonly workspace: WorkspaceValue | null
  readonly error: string | null
  readonly fixtureMode: FixtureMode
  readonly setFixtureMode: (mode: FixtureMode) => void
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

/**
 * One live subscription to the singleton workspace run, shared by the sidebar and every page.
 * The subscription renders as a sibling so pages never remount when the run id arrives.
 */
export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [runId, setRunId] = useState<string | null>(null)
  const [liveTree, setLiveTree] = useState<WorkspaceTree | null>(null)
  const [liveTabs, setLiveTabs] = useState<SessionTabsState>({})
  const [error, setError] = useState<string | null>(null)
  const [fixture, setFixture] = useState(() => ({ mode: initialFixtureMode(), at: Date.now() }))
  const fixtureMode = fixture.mode

  useEffect(() => {
    void fetchWorkspace()
      .then((result) => setRunId(result.runId))
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : 'Failed to load workspace'),
      )
  }, [])

  const fixtureTree = useMemo(
    () =>
      import.meta.env.DEV && fixture.mode !== 'live'
        ? workspaceFixture(fixture.mode, fixture.at)
        : null,
    [fixture],
  )

  const tree = fixtureTree ?? liveTree

  const value = useMemo<WorkspaceState>(
    () => ({
      workspace: runId && tree ? { runId, tree, tabs: liveTabs } : null,
      error: tree ? null : error,
      fixtureMode,
      setFixtureMode(mode) {
        sessionStorage.setItem(FIXTURE_KEY, mode)
        setFixture({ mode, at: Date.now() })
      },
    }),
    [runId, tree, liveTabs, error, fixtureMode],
  )

  return (
    <WorkspaceContext.Provider value={value}>
      {runId ? (
        <WorkspaceSubscription
          runId={runId}
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
  onTree,
  onTabs,
  onStalled,
}: {
  runId: string
  onTree: (tree: WorkspaceTree) => void
  onTabs: (tabs: SessionTabsState) => void
  onStalled: (message: string) => void
}) {
  const store = useRunStore(runId)
  const tree = useProjection(store, workspaceTree)
  const tabs = useProjection(store, sessionTabs)
  const summary = useRunSummary(store)
  const hydrated = summary.startedAt !== undefined
  const live = summary.connection === 'live'

  useEffect(() => {
    if (hydrated) {
      onTree(tree)
      onTabs(tabs)
    }
  }, [tree, tabs, hydrated, onTree, onTabs])

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

export function WorkspacePending({ label }: { label: string }) {
  const error = useWorkspaceError()

  return (
    <div className="text-muted-foreground flex h-full items-center justify-center px-6 text-center text-sm">
      {error ?? label}
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'

import { isCustomArtifactTabKind } from '@shuttle/api'

import { useShuttleHost } from '../../shuttle'
import {
  artifactTypeFor,
  defaultArtifactTypes,
  type ArtifactType,
} from '../artifacts/artifact-types'
import {
  closeSessionTab,
  openSessionTab,
  reorderSessionTabs,
  retargetSessionTab,
  type ArtifactTab,
  type ArtifactTabKind,
  type SessionTabSet,
} from '../workspace/workspace'
import { useOptionalWorkspace } from '../workspace/workspace-context'
import {
  applyPendingOps,
  neighborAfterClose,
  prunePendingOps,
  readActiveTabId,
  resolveActiveTabId,
  resolveTabSet,
  singletonTabId,
  tabTitleForKind,
  writeActiveTabId,
  type PendingTabOp,
} from './session-tabs'

export interface SessionTabsController {
  readonly tabs: SessionTabSet
  readonly activeTabId: string | null
  readonly setActiveTabId: (tabId: string) => void
  readonly openTab: (input: {
    kind: ArtifactTabKind
    title?: string
    target?: string
    tabId?: string
  }) => Promise<string>
  readonly closeTab: (tabId: string) => Promise<void>
  readonly reorderTabs: (tabIds: string[]) => Promise<void>
  readonly retargetTab: (tabId: string, title: string, target: string) => Promise<void>
  readonly focusKind: (kind: ArtifactTabKind) => Promise<string>
}

export function useSessionTabs(
  sessionRunId: string,
  types: readonly ArtifactType[] = defaultArtifactTypes,
): SessionTabsController {
  const host = useShuttleHost()
  // With no workspace above, nothing keeps the tabs: they last as long as the page does.
  const workspace = useOptionalWorkspace()
  const projected = workspace?.tabs[sessionRunId]
  const [pendingRaw, setPendingRaw] = useState<PendingTabOp[]>([])
  const [activeByRun, setActiveByRun] = useState<Record<string, string | null>>({})

  const pending = prunePendingOps(projected, pendingRaw)

  // Clear absorbed optimistic ops during render (React-approved props→state adjust).
  if (pending.length === 0 && pendingRaw.length > 0) {
    setPendingRaw([])
  }

  const base = resolveTabSet(projected)
  const tabs = applyPendingOps(base, pending)
  const preferred = activeByRun[sessionRunId] ?? readActiveTabId(sessionRunId)
  const resolvedActive = resolveActiveTabId(tabs, preferred)

  // Keep latest tabs in a ref so open/close callbacks stay identity-stable.
  // Otherwise effects that depend on them re-run every render.
  const tabsRef = useRef(tabs)
  const preferredRef = useRef(preferred)
  const resolvedActiveRef = useRef(resolvedActive)

  useEffect(() => {
    tabsRef.current = tabs
    preferredRef.current = preferred
    resolvedActiveRef.current = resolvedActive
  }, [tabs, preferred, resolvedActive])

  const setActiveTabId = useCallback(
    (tabId: string) => {
      setActiveByRun((prev) => ({ ...prev, [sessionRunId]: tabId }))
      writeActiveTabId(sessionRunId, tabId)
    },
    [sessionRunId],
  )

  const openTab = useCallback(
    async (input: { kind: ArtifactTabKind; title?: string; target?: string; tabId?: string }) => {
      const current = tabsRef.current

      const type = isCustomArtifactTabKind(input.kind)
        ? artifactTypeFor(types, input.kind)
        : undefined

      // One of the host's kinds says for itself whether it has one tab, and what to call it.
      const singleton = type?.single === true ? input.kind : singletonTabId(input.kind)

      if (singleton !== null && current.tabs[singleton] !== undefined) {
        setActiveTabId(singleton)
        return singleton
      }

      const tabId = input.tabId ?? singleton ?? crypto.randomUUID()
      const target = input.target ?? ''

      const title =
        input.title ?? type?.title?.(target) ?? type?.label ?? tabTitleForKind(input.kind, target)

      const tab: ArtifactTab = {
        tabId,
        kind: input.kind,
        title,
        target,
        openedAt: Date.now(),
      }

      setPendingRaw((prev) => [...prev, { kind: 'open', tab }])
      setActiveTabId(tabId)

      if (workspace) {
        await openSessionTab(host, workspace.listingRunId(sessionRunId), {
          runId: sessionRunId,
          tabId,
          kind: input.kind,
          title,
          target,
          at: tab.openedAt,
        })
      }

      return tabId
    },
    [host, sessionRunId, setActiveTabId, types, workspace],
  )

  const closeTab = useCallback(
    async (tabId: string) => {
      const current = tabsRef.current

      const nextActive = neighborAfterClose(current.order, tabId)
      setPendingRaw((prev) => [...prev, { kind: 'close', tabId }])

      if (preferredRef.current === tabId || resolvedActiveRef.current === tabId) {
        setActiveByRun((prev) => ({ ...prev, [sessionRunId]: nextActive }))
        writeActiveTabId(sessionRunId, nextActive)
      }

      if (workspace) {
        await closeSessionTab(host, workspace.listingRunId(sessionRunId), {
          runId: sessionRunId,
          tabId,
        })
      }
    },
    [host, sessionRunId, workspace],
  )

  const reorderTabs = useCallback(
    async (tabIds: string[]) => {
      setPendingRaw((prev) => [...prev, { kind: 'reorder', tabIds }])

      if (workspace) {
        await reorderSessionTabs(host, workspace.listingRunId(sessionRunId), {
          runId: sessionRunId,
          tabIds,
        })
      }
    },
    [host, sessionRunId, workspace],
  )

  const retargetTab = useCallback(
    async (tabId: string, title: string, target: string) => {
      setPendingRaw((prev) => [...prev, { kind: 'retarget', tabId, title, target }])

      if (workspace) {
        await retargetSessionTab(host, workspace.listingRunId(sessionRunId), {
          runId: sessionRunId,
          tabId,
          title,
          target,
        })
      }
    },
    [host, sessionRunId, workspace],
  )

  const focusKind = useCallback(async (kind: ArtifactTabKind) => openTab({ kind }), [openTab])

  return {
    tabs,
    activeTabId: resolvedActive,
    setActiveTabId,
    openTab,
    closeTab,
    reorderTabs,
    retargetTab,
    focusKind,
  }
}

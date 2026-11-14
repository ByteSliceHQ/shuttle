import { reduceTabMutation, type TabMutation } from './tab-set'
import type { ArtifactTab, ArtifactTabKind, SessionTabSet } from './workspace'

export const emptyTabSet: SessionTabSet = {
  order: [],
  tabs: {},
}

export function hasTabEvents(set: SessionTabSet | undefined): boolean {
  return Boolean(set && (set.order.length > 0 || Object.keys(set.tabs).length > 0))
}

/**
 * The tabs a session shows. Event history is no longer a tab — it opens as a drawer under the
 * session — so Events tabs saved by older sessions are left out. A session with nothing open
 * has no tabs.
 */
export function resolveTabSet(projected: SessionTabSet | undefined): SessionTabSet {
  const set = projected ?? emptyTabSet

  if (!Object.values(set.tabs).some((tab) => tab.kind === 'events')) {
    return set
  }

  const tabs: Record<string, ArtifactTab> = {}

  for (const [tabId, tab] of Object.entries(set.tabs)) {
    if (tab.kind !== 'events') {
      tabs[tabId] = tab
    }
  }

  return { order: set.order.filter((tabId) => tabs[tabId]), tabs }
}

export type PendingTabOp =
  | { readonly kind: 'open'; readonly tab: ArtifactTab }
  | { readonly kind: 'close'; readonly tabId: string }
  | { readonly kind: 'reorder'; readonly tabIds: readonly string[] }
  | {
      readonly kind: 'retarget'
      readonly tabId: string
      readonly title: string
      readonly target: string
    }

function pendingToMutation(op: PendingTabOp): TabMutation {
  switch (op.kind) {
    case 'open':
      return { type: 'open', tab: op.tab }
    case 'close':
      return { type: 'close', tabId: op.tabId }
    case 'reorder':
      return { type: 'reorder', tabIds: op.tabIds }
    case 'retarget':
      return { type: 'retarget', tabId: op.tabId, title: op.title, target: op.target }

    default: {
      const exhaustive: never = op

      return exhaustive
    }
  }
}

export function applyPendingOps(
  base: SessionTabSet,
  pending: readonly PendingTabOp[],
): SessionTabSet {
  let next = base

  for (const op of pending) {
    next = reduceTabMutation(next, pendingToMutation(op))
  }

  return next
}

function tabSetsEqual(left: SessionTabSet, right: SessionTabSet): boolean {
  if (left.order.join('\0') !== right.order.join('\0')) {
    return false
  }

  for (const id of left.order) {
    const a = left.tabs[id]
    const b = right.tabs[id]

    if (!a || !b) {
      return false
    }

    if (a.kind !== b.kind || a.title !== b.title || a.target !== b.target || a.tabId !== b.tabId) {
      return false
    }
  }

  return true
}

/**
 * Drop the whole pending queue once the projection matches what those ops would
 * produce. Partial absorption keeps the queue so optimistic UI stays coherent.
 */
export function prunePendingOps(
  projected: SessionTabSet | undefined,
  pending: readonly PendingTabOp[],
): PendingTabOp[] {
  if (pending.length === 0) {
    return []
  }

  if (!hasTabEvents(projected)) {
    return [...pending]
  }

  const base = projected ?? emptyTabSet
  const overlay = applyPendingOps(base, pending)

  return tabSetsEqual(overlay, base) ? [] : [...pending]
}

const ACTIVE_KEY_PREFIX = 'shuttle.active-tab:'

export function activeTabStorageKey(runId: string): string {
  return `${ACTIVE_KEY_PREFIX}${runId}`
}

export function readActiveTabId(runId: string): string | null {
  try {
    return sessionStorage.getItem(activeTabStorageKey(runId))
  } catch {
    return null
  }
}

export function writeActiveTabId(runId: string, tabId: string | null) {
  try {
    const key = activeTabStorageKey(runId)

    if (tabId) {
      sessionStorage.setItem(key, tabId)
    } else {
      sessionStorage.removeItem(key)
    }
  } catch {
    // Private mode / quota — active tab is ephemeral anyway.
  }
}

/** Prefer the remembered tab when still open; otherwise the neighbour of a closed tab, else first. */
export function resolveActiveTabId(
  set: SessionTabSet,
  preferred: string | null | undefined,
  closedTabId?: string,
): string | null {
  if (set.order.length === 0) {
    return null
  }

  if (preferred && set.tabs[preferred]) {
    return preferred
  }

  if (closedTabId) {
    const index = set.order.indexOf(closedTabId)

    if (index >= 0) {
      return set.order[Math.min(index, set.order.length - 1)] ?? null
    }
  }

  return set.order[0] ?? null
}

export function neighborAfterClose(
  previousOrder: readonly string[],
  closedTabId: string,
): string | null {
  const index = previousOrder.indexOf(closedTabId)

  if (index < 0) {
    return previousOrder[0] ?? null
  }

  if (index + 1 < previousOrder.length) {
    return previousOrder[index + 1] ?? null
  }

  if (index - 1 >= 0) {
    return previousOrder[index - 1] ?? null
  }

  return null
}

export function tabTitleForKind(kind: ArtifactTabKind, target?: string): string {
  switch (kind) {
    case 'events':
      return 'Events'
    case 'files':
      return 'Workspace'
    case 'file':
      return target?.split('/').pop() || 'File'
    case 'changes':
      return 'Changes'
    case 'terminal':
      return 'Terminal'
    case 'browser':
      return target ? browserTitle(target) : 'Browser'
    case 'review':
      return 'Review'

    default: {
      const exhaustive: never = kind

      return exhaustive
    }
  }
}

function browserTitle(target: string): string {
  if (/^\d+$/.test(target)) {
    return `:${target}`
  }

  try {
    const url = new URL(target)

    return url.host || 'Browser'
  } catch {
    return target.slice(0, 24) || 'Browser'
  }
}

export function singletonTabId(kind: ArtifactTabKind): string | null {
  switch (kind) {
    case 'events':
      return 'events'
    case 'files':
      return 'files'
    case 'changes':
      return 'changes'
    case 'review':
      return 'review'
    case 'file':
    case 'terminal':
    case 'browser':
      return null

    default: {
      const exhaustive: never = kind

      return exhaustive
    }
  }
}

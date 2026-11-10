import type { ArtifactTab, ArtifactTabKind, SessionTabSet } from './workspace'

export type TabMutation =
  | { readonly type: 'open'; readonly tab: ArtifactTab }
  | { readonly type: 'close'; readonly tabId: string }
  | { readonly type: 'reorder'; readonly tabIds: readonly string[] }
  | {
      readonly type: 'retarget'
      readonly tabId: string
      readonly title: string
      readonly target: string
    }

/** Pure tab-set transitions shared by the web projection and optimistic overlay. */
export function reduceTabMutation(base: SessionTabSet, mutation: TabMutation): SessionTabSet {
  switch (mutation.type) {
    case 'open': {
      if (base.tabs[mutation.tab.tabId]) {
        return base
      }

      return {
        order: [...base.order, mutation.tab.tabId],
        tabs: { ...base.tabs, [mutation.tab.tabId]: mutation.tab },
      }
    }

    case 'close': {
      if (!base.tabs[mutation.tabId]) {
        return base
      }

      const tabs = { ...base.tabs }
      delete tabs[mutation.tabId]

      return {
        order: base.order.filter((id) => id !== mutation.tabId),
        tabs,
      }
    }

    case 'reorder': {
      const known = new Set(base.order)
      const order = mutation.tabIds.filter((id) => known.has(id))
      const missing = base.order.filter((id) => !order.includes(id))

      return { ...base, order: [...order, ...missing] }
    }

    case 'retarget': {
      const tab = base.tabs[mutation.tabId]

      if (!tab) {
        return base
      }

      return {
        ...base,
        tabs: {
          ...base.tabs,
          [mutation.tabId]: { ...tab, title: mutation.title, target: mutation.target },
        },
      }
    }

    default: {
      const exhaustive: never = mutation

      return exhaustive
    }
  }
}

export function reduceTabEvent(
  state: Readonly<Record<string, SessionTabSet>>,
  event: {
    readonly type: string
    readonly payload: Record<string, unknown>
  },
): Readonly<Record<string, SessionTabSet>> {
  switch (event.type) {
    case 'workspace.tab.opened': {
      const runId = String(event.payload.runId ?? '')
      const tabId = String(event.payload.tabId ?? '')
      const existing = state[runId] ?? { order: [], tabs: {} }

      const next = reduceTabMutation(existing, {
        type: 'open',
        tab: {
          tabId,
          kind: event.payload.kind as ArtifactTabKind,
          title: String(event.payload.title ?? ''),
          target: String(event.payload.target ?? ''),
          openedAt: Number(event.payload.at ?? 0),
        },
      })

      return next === existing ? state : { ...state, [runId]: next }
    }

    case 'workspace.tab.closed': {
      const runId = String(event.payload.runId ?? '')
      const tabId = String(event.payload.tabId ?? '')
      const existing = state[runId]

      if (!existing) {
        return state
      }

      const next = reduceTabMutation(existing, { type: 'close', tabId })
      return next === existing ? state : { ...state, [runId]: next }
    }

    case 'workspace.tab.reordered': {
      const runId = String(event.payload.runId ?? '')
      const tabIds = (event.payload.tabIds as readonly string[] | undefined) ?? []
      const existing = state[runId]

      if (!existing) {
        return state
      }

      const next = reduceTabMutation(existing, { type: 'reorder', tabIds })
      return next === existing ? state : { ...state, [runId]: next }
    }

    case 'workspace.tab.retargeted': {
      const runId = String(event.payload.runId ?? '')
      const tabId = String(event.payload.tabId ?? '')
      const existing = state[runId]

      if (!existing) {
        return state
      }

      const next = reduceTabMutation(existing, {
        type: 'retarget',
        tabId,
        title: String(event.payload.title ?? ''),
        target: String(event.payload.target ?? ''),
      })

      return next === existing ? state : { ...state, [runId]: next }
    }

    default:
      return state
  }
}

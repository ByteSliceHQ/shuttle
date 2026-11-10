import type { ArtifactTab, ArtifactTabKind } from './scope'

export type SessionTabSet = {
  readonly order: readonly string[]
  readonly tabs: Readonly<Record<string, ArtifactTab>>
}

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

/** Pure tab-set transitions — keep in sync with apps/web/src/lib/tab-set.ts. */
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

export function reduceSessionTabsState(
  state: Readonly<Record<string, SessionTabSet>>,
  event: { readonly type: string; readonly payload: unknown },
): Readonly<Record<string, SessionTabSet>> {
  if (
    event.type !== 'workspace.tab.opened' &&
    event.type !== 'workspace.tab.closed' &&
    event.type !== 'workspace.tab.reordered' &&
    event.type !== 'workspace.tab.retargeted'
  ) {
    return state
  }

  const payload = event.payload as {
    readonly runId: string
    readonly tabId?: string
    readonly tabIds?: readonly string[]
    readonly kind?: ArtifactTabKind
    readonly title?: string
    readonly target?: string
    readonly at?: number
  }

  const { runId } = payload
  const existing = state[runId] ?? { order: [], tabs: {} }

  switch (event.type) {
    case 'workspace.tab.opened': {
      const next = reduceTabMutation(existing, {
        type: 'open',
        tab: {
          tabId: payload.tabId ?? '',
          kind: payload.kind ?? 'events',
          title: payload.title ?? '',
          target: payload.target ?? '',
          openedAt: payload.at ?? 0,
        },
      })

      return next === existing ? state : { ...state, [runId]: next }
    }

    case 'workspace.tab.closed': {
      if (!state[runId]) {
        return state
      }

      const next = reduceTabMutation(existing, { type: 'close', tabId: payload.tabId ?? '' })
      return next === existing ? state : { ...state, [runId]: next }
    }

    case 'workspace.tab.reordered': {
      if (!state[runId]) {
        return state
      }

      const next = reduceTabMutation(existing, {
        type: 'reorder',
        tabIds: payload.tabIds ?? [],
      })

      return next === existing ? state : { ...state, [runId]: next }
    }

    case 'workspace.tab.retargeted': {
      if (!state[runId]) {
        return state
      }

      const next = reduceTabMutation(existing, {
        type: 'retarget',
        tabId: payload.tabId ?? '',
        title: payload.title ?? '',
        target: payload.target ?? '',
      })

      return next === existing ? state : { ...state, [runId]: next }
    }

    default:
      return state
  }
}

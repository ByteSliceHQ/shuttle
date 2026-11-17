import type { ArtifactTab, SessionTabSet } from '@/features/workspace/workspace'

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

/** Applies one tab mutation to a session's tab set. Only `open` creates a missing tab set. */
export function mutateSessionTabs(
  state: Readonly<Record<string, SessionTabSet>>,
  runId: string,
  mutation: TabMutation,
): Readonly<Record<string, SessionTabSet>> {
  const existing = state[runId]

  if (!existing && mutation.type !== 'open') {
    return state
  }

  const base = existing ?? { order: [], tabs: {} }
  const next = reduceTabMutation(base, mutation)

  return next === base ? state : { ...state, [runId]: next }
}

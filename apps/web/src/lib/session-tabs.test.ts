import { describe, expect, test } from 'bun:test'

import {
  applyPendingOps,
  defaultTabSet,
  neighborAfterClose,
  prunePendingOps,
  resolveActiveTabId,
  resolveTabSet,
  tabTitleForKind,
  type PendingTabOp,
} from './session-tabs'
import type { ArtifactTab, SessionTabSet } from './workspace'

const events: ArtifactTab = {
  tabId: 'events',
  kind: 'events',
  title: 'Events',
  target: '',
  openedAt: 1,
}

const files: ArtifactTab = {
  tabId: 'files',
  kind: 'files',
  title: 'Files',
  target: '',
  openedAt: 2,
}

const browser: ArtifactTab = {
  tabId: 'browser',
  kind: 'browser',
  title: 'Browser',
  target: '3000',
  openedAt: 3,
}

function set(tabs: ArtifactTab[], order?: string[]): SessionTabSet {
  return {
    order: order ?? tabs.map((tab) => tab.tabId),
    tabs: Object.fromEntries(tabs.map((tab) => [tab.tabId, tab])),
  }
}

describe('session-tabs', () => {
  test('defaults to a single Events tab when projection is empty', () => {
    expect(resolveTabSet(undefined).order).toEqual(['events'])
    expect(resolveTabSet({ order: [], tabs: {} }).order).toEqual(['events'])
  })

  test('keeps Events pinned when other tabs open without it', () => {
    const resolved = resolveTabSet(set([files]))

    expect(resolved.order).toEqual(['events', 'files'])
    expect(resolved.tabs.events?.kind).toBe('events')
    expect(resolveTabSet(set([events, files])).order).toEqual(['events', 'files'])
  })

  test('applies and prunes optimistic open/close/reorder/retarget', () => {
    const base = set([events, files])

    const pending: PendingTabOp[] = [
      { kind: 'open', tab: browser },
      { kind: 'reorder', tabIds: ['browser', 'events', 'files'] },
      { kind: 'retarget', tabId: 'browser', title: 'App', target: 'http://localhost:3000' },
      { kind: 'close', tabId: 'files' },
    ]

    const overlay = applyPendingOps(base, pending)

    expect(overlay.order).toEqual(['browser', 'events'])
    expect(overlay.tabs.browser?.title).toBe('App')
    expect(overlay.tabs.files).toBeUndefined()

    const projected = applyPendingOps(base, pending)

    expect(prunePendingOps(projected, pending)).toEqual([])
    expect(prunePendingOps(base, pending)).toHaveLength(4)
  })

  test('resolves active tab with neighbour fallback after close', () => {
    const tabs = set([events, files, browser])
    expect(resolveActiveTabId(tabs, 'files')).toBe('files')
    expect(resolveActiveTabId(tabs, 'missing')).toBe('events')
    expect(neighborAfterClose(['events', 'files', 'browser'], 'files')).toBe('browser')
    expect(neighborAfterClose(['events', 'files', 'browser'], 'browser')).toBe('files')
    expect(neighborAfterClose(['events'], 'events')).toBeNull()
    expect(resolveActiveTabId(defaultTabSet(), null)).toBe('events')
  })

  test('titles browsers and file paths', () => {
    expect(tabTitleForKind('file', '/workspace/.wt/s1/repo/src/main.ts')).toBe('main.ts')
    expect(tabTitleForKind('browser', '3000')).toBe(':3000')
    expect(tabTitleForKind('browser', 'http://127.0.0.1:5173/app')).toBe('127.0.0.1:5173')
  })
})

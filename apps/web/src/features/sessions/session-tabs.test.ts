import { describe, expect, test } from 'bun:test'

import type { ArtifactTab, SessionTabSet } from '@/features/workspace/workspace'

import {
  applyPendingOps,
  neighborAfterClose,
  prunePendingOps,
  resolveActiveTabId,
  resolveTabSet,
  singletonTabId,
  tabTitleForKind,
  type PendingTabOp,
} from './session-tabs'

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
  test('shows no tabs when nothing is open', () => {
    expect(resolveTabSet(undefined).order).toEqual([])
    expect(resolveTabSet({ order: [], tabs: {} }).order).toEqual([])
  })

  test('leaves out Events tabs saved by older sessions', () => {
    const resolved = resolveTabSet(set([events, files]))

    expect(resolved.order).toEqual(['files'])
    expect(resolved.tabs.events).toBeUndefined()
    expect(resolveTabSet(set([events])).order).toEqual([])
    expect(resolveTabSet(set([files, browser])).order).toEqual(['files', 'browser'])
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
    expect(resolveActiveTabId(resolveTabSet(undefined), null)).toBeNull()
  })

  test('titles browsers and file paths', () => {
    expect(tabTitleForKind('file', '/workspace/.wt/s1/repo/src/main.ts')).toBe('main.ts')
    expect(tabTitleForKind('browser', '3000')).toBe(':3000')
    expect(tabTitleForKind('browser', 'http://127.0.0.1:5173/app')).toBe('127.0.0.1:5173')
  })

  test("a host's own kind is named after itself and can have many tabs", () => {
    expect(tabTitleForKind('acme:designs')).toBe('designs')
    expect(singletonTabId('acme:designs')).toBeNull()
    expect(singletonTabId('review')).toBe('review')
  })
})

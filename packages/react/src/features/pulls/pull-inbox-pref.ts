import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'shuttle.pullInbox.collapsed'
const listeners = new Set<() => void>()

function read(): boolean {
  return typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY) === '1'
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify)
  return () => listeners.delete(notify)
}

export function setPullInboxCollapsed(collapsed: boolean): void {
  localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0')

  for (const notify of listeners) {
    notify()
  }
}

export function usePullInboxCollapsed(): boolean {
  return useSyncExternalStore(subscribe, read, () => false)
}

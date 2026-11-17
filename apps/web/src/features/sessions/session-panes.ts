import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
import { usePanelRef, type PanelImperativeHandle, type PanelSize } from 'react-resizable-panels'

const AGENTS_OPEN_KEY = 'shuttle.agents-open'
const EVENTS_OPEN_KEY = 'shuttle.events-open'
const ARTIFACTS_OPEN_PREFIX = 'shuttle.artifacts-open:'

function readFlag(storage: () => Storage, key: string): boolean | null {
  try {
    const stored = storage().getItem(key)

    return stored === '1' ? true : stored === '0' ? false : null
  } catch {
    return null
  }
}

function writeFlag(storage: () => Storage, key: string, value: boolean) {
  try {
    storage().setItem(key, value ? '1' : '0')
  } catch {
    // Private mode or a full quota: the pane still opens, it just isn't remembered.
  }
}

/** An open/closed preference that holds across sessions and reloads. */
function useStoredFlag(key: string, fallback: boolean): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState(() => readFlag(() => localStorage, key) ?? fallback)

  useEffect(() => {
    writeFlag(() => localStorage, key, value)
  }, [key, value])

  return [value, setValue]
}

/** Whether the agents pane is open. Closed until the reader asks for it. */
export function useAgentsOpen() {
  return useStoredFlag(AGENTS_OPEN_KEY, false)
}

/** Whether the event history drawer is open. Closed until the reader asks for it. */
export function useEventsOpen() {
  return useStoredFlag(EVENTS_OPEN_KEY, false)
}

/**
 * Whether the reader opened or closed this session's artifacts pane themself. `null` until they
 * do, and the pane then follows whether the session has anything open in it.
 */
export function useArtifactsChoice(runId: string): [boolean | null, (next: boolean) => void] {
  const key = `${ARTIFACTS_OPEN_PREFIX}${runId}`
  const [choice, setChoice] = useState(() => readFlag(() => sessionStorage, key))

  const choose = useCallback(
    (next: boolean) => {
      setChoice(next)
      writeFlag(() => sessionStorage, key, next)
    },
    [key],
  )

  return [choice, choose]
}

/**
 * Keeps a collapsible panel in step with whether its pane is open. Dragging a panel shut or
 * open reports back through `onResize`, so the toggle and the drag never disagree.
 */
export function useCollapsiblePanel({
  open,
  onOpenChange,
  preferredSize,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The size to open at the first time, before the reader has sized the panel themself. */
  preferredSize: string
}) {
  const panelRef = usePanelRef()
  const wanted = useRef(open)
  // The size to reopen at: the last one the panel had while open, as a percentage.
  const lastSize = useRef<number | null>(null)

  // The panel handle this hook last looked at. A panel that has only just mounted already has
  // the right size from `defaultSize`, and its group has not registered it yet, so asking it
  // anything throws.
  const seen = useRef<PanelImperativeHandle | null>(null)

  // Runs after every render, not only when `open` changes: the panel unmounts and remounts when
  // the layout changes, and this is how the hook notices. Each check is a no-op once in step.
  useEffect(() => {
    wanted.current = open
    const panel: PanelImperativeHandle | null = panelRef.current

    if (seen.current !== panel) {
      seen.current = panel

      return
    }

    if (!panel) {
      return
    }

    try {
      if (!open) {
        if (!panel.isCollapsed()) {
          panel.collapse()
        }
      } else if (panel.isCollapsed()) {
        panel.resize(lastSize.current === null ? preferredSize : `${lastSize.current}%`)
      }
    } catch {
      // The group is between layouts. The next render brings the panel back in step.
    }
  })

  const onResize = useCallback(
    (size: PanelSize, _id: string | number | undefined, previous: PanelSize | undefined) => {
      const nowOpen = size.asPercentage > 0

      if (nowOpen) {
        lastSize.current = size.asPercentage
      }

      // Only a drag disagrees with what was asked for; that is the reader's own choice.
      if (previous !== undefined && nowOpen !== wanted.current) {
        onOpenChange(nowOpen)
      }
    },
    [onOpenChange],
  )

  return { panelRef, onResize, defaultSize: open ? preferredSize : '0' }
}

export interface PaneShortcut {
  /** The letter pressed with ⌘ on a Mac and Ctrl elsewhere. */
  readonly key: string
  readonly shift?: boolean
  readonly run: () => void
}

function isMac(): boolean {
  return typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.userAgent)
}

/** How a shortcut reads in a tooltip, e.g. `⌘⇧B` or `Ctrl+Shift+B`. */
export function shortcutLabel(shortcut: Pick<PaneShortcut, 'key' | 'shift'>): string {
  const key = shortcut.key.toUpperCase()

  if (isMac()) {
    return `⌘${shortcut.shift ? '⇧' : ''}${key}`
  }

  return `Ctrl+${shortcut.shift ? 'Shift+' : ''}${key}`
}

/** Runs pane shortcuts from anywhere on the page. */
export function usePaneShortcuts(shortcuts: readonly PaneShortcut[]) {
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    const mac = isMac()
    const chord = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey

    if (!chord || event.altKey) {
      return
    }

    // Off a Mac these are Ctrl chords, which inside a terminal belong to the shell.
    if (!mac && event.target instanceof Element && event.target.closest('.xterm')) {
      return
    }

    const key = event.key.toLowerCase()

    const match = shortcuts.find(
      (shortcut) => shortcut.key === key && Boolean(shortcut.shift) === event.shiftKey,
    )

    if (match) {
      event.preventDefault()
      match.run()
    }
  })

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown, true)

    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])
}

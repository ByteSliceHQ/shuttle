import { useRouterState } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'

import {
  activitySnapshot,
  attentionChanges,
  attentionCount,
  attentionMessage,
} from '@/lib/attention'
import { desktop } from '@/lib/desktop'
import { useTenant } from '@/lib/tenant'

import { useWorkspace } from './sidebar/workspace-context'

function sessionOnScreen(pathname: string): string | null {
  const match = pathname.match(/^\/sessions\/([^/]+)$/)

  return match?.[1] ? decodeURIComponent(match[1]) : null
}

/**
 * In the desktop app, keeps the Dock badge at the number of sessions waiting on this person and
 * says so when one of theirs stops working while they are looking elsewhere. Renders nothing,
 * and does nothing in a browser.
 */
export function DesktopAttention() {
  const app = desktop()
  const userId = useTenant().user.id
  const sessions = useWorkspace()?.tree.sessions
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const previous = useRef<Record<string, string> | null>(null)

  useEffect(() => {
    if (!app || !sessions) {
      return
    }

    // A session on screen in a focused window needs no calling back to.
    const watching = document.hasFocus() ? sessionOnScreen(pathname) : null

    app.setBadge?.(attentionCount(sessions, userId, watching))

    if (previous.current) {
      for (const change of attentionChanges(previous.current, sessions, userId)) {
        if (change.runId !== watching) {
          app.notify?.({
            title: change.title || 'Shuttle',
            body: attentionMessage(change.kind),
            path: `/sessions/${encodeURIComponent(change.runId)}`,
          })
        }
      }
    }

    previous.current = activitySnapshot(sessions, userId)
  }, [app, sessions, userId, pathname])

  // Coming back to the window clears the badge for the session that is on screen.
  useEffect(() => {
    if (!app || !sessions) {
      return
    }

    const refresh = () =>
      app.setBadge?.(
        attentionCount(sessions, userId, document.hasFocus() ? sessionOnScreen(pathname) : null),
      )

    window.addEventListener('focus', refresh)
    window.addEventListener('blur', refresh)

    return () => {
      window.removeEventListener('focus', refresh)
      window.removeEventListener('blur', refresh)
    }
  }, [app, sessions, userId, pathname])

  return null
}

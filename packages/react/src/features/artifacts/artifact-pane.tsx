import { useQueryClient } from '@tanstack/react-query'
import { LayoutPanelTop } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { Button } from '../../components/ui/button'
import { EmptyState } from '../../components/ui/panel'
import { cn } from '../../lib/cn'
import { useShuttleHost } from '../../shuttle'
import type { SessionEvent } from '../events/event-catalog'
import type { AgentIdentity } from '../sessions/agents'
import type { SessionMedia } from '../sessions/media'
import type { SessionTabsController } from '../sessions/use-session-tabs'
import {
  artifactTypeFor,
  defaultArtifactTypes,
  launchableArtifactTypes,
  type ArtifactType,
} from './artifact-types'
import { invalidateWorktree } from './sandbox'
import { TabStrip } from './tab-strip'

export function ArtifactPane({
  runId,
  folderId,
  events,
  media,
  identities,
  controller,
  onReveal,
  types = defaultArtifactTypes,
}: {
  runId: string
  folderId?: string
  events: readonly SessionEvent[]
  /** The session's files: what people attached and what agents shared. */
  media: readonly SessionMedia[]
  identities: ReadonlyMap<string, AgentIdentity>
  /** The session's tabs. The page owns them, since whether the pane shows depends on them. */
  controller: SessionTabsController
  /** Asks the page to show the pane, for a shortcut that opens a tab while it is closed. */
  onReveal?: () => void
  /** The kinds of tab the pane can show. Shuttle's own, unless the session was given others. */
  types?: readonly ArtifactType[]
}) {
  const host = useShuttleHost()

  const { tabs, activeTabId, setActiveTabId, openTab, closeTab, reorderTabs, retargetTab } =
    controller

  const orderedTabs = useMemo(
    () => tabs.order.flatMap((id) => (tabs.tabs[id] ? [tabs.tabs[id]] : [])),
    [tabs],
  )

  // Tools are how agents change files, so each tool event in the session's stream marks what
  // the tabs have read from the worktree as out of date. The tabs showing it read it again.
  const toolEvents = useMemo(
    () =>
      events.filter((event) => event.type.startsWith('agent.tool') || event.type.includes('tool'))
        .length,
    [events],
  )

  const queryClient = useQueryClient()

  useEffect(() => {
    if (toolEvents > 0) {
      void invalidateWorktree(host, queryClient, runId)
    }
  }, [host, queryClient, runId, toolEvents])

  // Go to file, on the shortcut editors use for it. It brings the Files tab forward and opens
  // its search, from anywhere on the page.
  const [searchToken, setSearchToken] = useState(0)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mac = /mac|iphone|ipad/i.test(navigator.userAgent)
      const chord = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey

      if (!chord || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'p') {
        return
      }

      // In a terminal Ctrl+P belongs to the shell: it recalls the previous command.
      if (!mac && event.target instanceof Element && event.target.closest('.xterm')) {
        return
      }

      event.preventDefault()
      onReveal?.()
      void openTab({ kind: 'files' })
      setSearchToken(Date.now())
    }

    window.addEventListener('keydown', onKeyDown, true)

    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [openTab, onReveal])

  return (
    <div className="bg-sidebar flex h-full min-h-0 flex-col">
      <TabStrip
        tabs={orderedTabs}
        types={types}
        activeTabId={activeTabId}
        onSelect={setActiveTabId}
        onClose={(tabId) => void closeTab(tabId)}
        onReorder={(tabIds) => void reorderTabs(tabIds)}
        onOpen={(kind) => void openTab({ kind })}
      />

      {orderedTabs.length === 0 ? (
        <EmptyState icon={<LayoutPanelTop />} title="Nothing open yet">
          <span className="mb-3 block">
            Open the workspace to see files and changes, or start a terminal or a browser preview.
          </span>
          <span className="flex flex-wrap justify-center gap-1.5">
            {launchableArtifactTypes(types)
              .filter((type) => type.launcher?.starter)
              .map((type) => (
                <Button
                  key={type.kind}
                  variant="secondary"
                  size="sm"
                  onClick={() => void openTab({ kind: type.kind })}
                >
                  {type.icon}
                  {type.label}
                </Button>
              ))}
          </span>
        </EmptyState>
      ) : (
        <div className="relative min-h-0 flex-1">
          {orderedTabs.map((tab) => {
            const active = tab.tabId === activeTabId

            return (
              <div
                key={tab.tabId}
                data-artifact-tab={tab.tabId}
                data-artifact-kind={tab.kind}
                data-active={active ? 'true' : 'false'}
                // `hidden` (display:none) — not `invisible` — so inactive panels can't paint over the active one.
                className={cn('absolute inset-0 flex min-h-0 flex-col', !active && 'hidden')}
                aria-hidden={!active}
              >
                {artifactTypeFor(types, tab.kind)?.render({
                  tab,
                  runId,
                  folderId,
                  searchToken,
                  media,
                  identities,
                  retarget: (title, target) => void retargetTab(tab.tabId, title, target),
                })}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

import { useQueryClient } from '@tanstack/react-query'
import { Files, Globe, LayoutPanelTop, SquareTerminal } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/panel'
import type { SessionEvent } from '@/features/events/event-catalog'
import type { AgentIdentity } from '@/features/sessions/agents'
import type { SessionMedia } from '@/features/sessions/media'
import type { SessionTabsController } from '@/features/sessions/use-session-tabs'
import type { ArtifactTab, ArtifactTabKind } from '@/features/workspace/workspace'
import { cn } from '@/lib/cn'

import { BrowserViewer } from './browser-viewer'
import { MediaViewer } from './media-viewer'
import { ReviewViewer } from './review-viewer'
import { invalidateWorktree } from './sandbox'
import { TabStrip } from './tab-strip'
import { TerminalViewer } from './terminal-viewer'
import { WorkspaceViewer } from './workspace-viewer'

const STARTERS: readonly { kind: ArtifactTabKind; label: string; icon: ReactNode }[] = [
  { kind: 'files', label: 'Workspace', icon: <Files /> },
  { kind: 'terminal', label: 'Terminal', icon: <SquareTerminal /> },
  { kind: 'browser', label: 'Browser', icon: <Globe /> },
]

export function ArtifactPane({
  runId,
  folderId,
  events,
  media,
  identities,
  controller,
  onReveal,
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
}) {
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
      void invalidateWorktree(queryClient, runId)
    }
  }, [queryClient, runId, toolEvents])

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
            {STARTERS.map((starter) => (
              <Button
                key={starter.kind}
                variant="secondary"
                size="sm"
                onClick={() => void openTab({ kind: starter.kind })}
              >
                {starter.icon}
                {starter.label}
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
                <ArtifactViewer
                  tab={tab}
                  runId={runId}
                  folderId={folderId}
                  searchToken={searchToken}
                  media={media}
                  identities={identities}
                  onRetarget={(title, target) => void retargetTab(tab.tabId, title, target)}
                />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ArtifactViewer({
  tab,
  runId,
  folderId,
  searchToken,
  media,
  identities,
  onRetarget,
}: {
  tab: ArtifactTab
  runId: string
  folderId?: string
  searchToken: number
  media: readonly SessionMedia[]
  identities: ReadonlyMap<string, AgentIdentity>
  onRetarget: (title: string, target: string) => void
}) {
  switch (tab.kind) {
    // Event history opens as a drawer under the session; it is never shown as a tab.
    case 'events':
      return null
    // One tab shows the workspace. Tabs saved under its earlier names open it too: a Changes
    // tab on what changed, a single-file tab on that file.
    case 'files':
    case 'changes':
    case 'file':
      return (
        <WorkspaceViewer
          key={runId}
          runId={runId}
          searchToken={searchToken}
          initialFilter={tab.kind === 'changes' ? 'changed' : undefined}
          initialPath={tab.kind === 'file' ? worktreePath(runId, tab.target) : undefined}
        />
      )
    case 'terminal':
      return <TerminalViewer runId={runId} folderId={folderId} cwd={tab.target} />
    case 'browser':
      return <BrowserViewer runId={runId} target={tab.target} onRetarget={onRetarget} />
    case 'review':
      return <ReviewViewer runId={runId} folderId={folderId} />
    case 'media':
      return <MediaViewer runId={runId} media={media} identities={identities} />

    default: {
      const exhaustive: never = tab.kind

      return exhaustive
    }
  }
}

/** A file tab's target as a path under the session's worktree, which is how the Files tab names files. */
function worktreePath(runId: string, target: string): string {
  const root = `/workspace/.wt/${runId}/`

  return target.startsWith(root) ? target.slice(root.length) : target
}

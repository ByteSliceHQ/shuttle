import { LayoutPanelTop } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'

import { EventStream } from '@/components/event-stream'
import { EmptyState } from '@/components/ui/panel'
import { cn } from '@/lib/cn'
import type { SessionEvent } from '@/lib/event-catalog'
import { useSessionTabs } from '@/lib/use-session-tabs'
import type { ArtifactTab } from '@/lib/workspace'

import { BrowserViewer } from './browser-viewer'
import { ChangesViewer } from './changes-viewer'
import { FileViewer } from './file-viewer'
import { FilesViewer } from './files-viewer'
import { ReviewViewer } from './review-viewer'
import { TabStrip } from './tab-strip'
import { TerminalViewer } from './terminal-viewer'

export function ArtifactPane({
  runId,
  folderId,
  events,
  startedAt,
  threadId,
  threadLabel,
  labelFor,
  onClearThread,
  selectedSeq,
  onSelectSeq,
  identities,
  focusEventsToken,
}: {
  runId: string
  folderId?: string
  events: readonly SessionEvent[]
  startedAt?: number
  threadId?: string
  threadLabel?: string
  labelFor: (threadId: string | null) => string | undefined
  onClearThread?: () => void
  selectedSeq?: number
  onSelectSeq: (seq: number | undefined) => void
  identities: ReadonlyMap<string, { label: string }>
  /** Bumped when conversation asks to inspect — focuses Events. */
  focusEventsToken?: number
}) {
  const controller = useSessionTabs(runId)

  const { tabs, activeTabId, setActiveTabId, openTab, closeTab, reorderTabs, retargetTab } =
    controller

  const orderedTabs = useMemo(
    () => tabs.order.flatMap((id) => (tabs.tabs[id] ? [tabs.tabs[id]] : [])),
    [tabs],
  )

  // Shared invalidation signal — viewers refetch without remounting.
  const refreshEpoch = useMemo(
    () =>
      events.filter((event) => event.type.startsWith('agent.tool') || event.type.includes('tool'))
        .length,
    [events],
  )

  // Only react to real inspect bumps — not mount (token 0) and not openTab identity churn.
  const lastFocusToken = useRef(0)

  useEffect(() => {
    if (focusEventsToken === undefined || focusEventsToken <= 0) {
      return
    }

    if (focusEventsToken === lastFocusToken.current) {
      return
    }

    lastFocusToken.current = focusEventsToken
    void openTab({ kind: 'events' })
  }, [focusEventsToken, openTab])

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
        <EmptyState icon={<LayoutPanelTop />} title="No open tabs">
          Use + to open Events, Files, Changes, Terminal, or Browser.
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
                  events={events}
                  startedAt={startedAt}
                  threadId={threadId}
                  threadLabel={threadLabel}
                  labelFor={labelFor}
                  onClearThread={onClearThread}
                  selectedSeq={selectedSeq}
                  onSelectSeq={onSelectSeq}
                  identities={identities}
                  refreshEpoch={refreshEpoch}
                  onOpenFile={(path) =>
                    void openTab({
                      kind: 'file',
                      target: path,
                      title: path.split('/').pop() || 'File',
                    })
                  }
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
  events,
  startedAt,
  threadId,
  threadLabel,
  labelFor,
  onClearThread,
  selectedSeq,
  onSelectSeq,
  identities,
  refreshEpoch,
  onOpenFile,
  onRetarget,
}: {
  tab: ArtifactTab
  runId: string
  folderId?: string
  events: readonly SessionEvent[]
  startedAt?: number
  threadId?: string
  threadLabel?: string
  labelFor: (threadId: string | null) => string | undefined
  onClearThread?: () => void
  selectedSeq?: number
  onSelectSeq: (seq: number | undefined) => void
  identities: ReadonlyMap<string, { label: string }>
  refreshEpoch: number
  onOpenFile: (path: string) => void
  onRetarget: (title: string, target: string) => void
}) {
  switch (tab.kind) {
    case 'events':
      return (
        <EventStream
          events={events}
          startedAt={startedAt}
          threadId={threadId}
          threadLabel={threadLabel}
          labelFor={labelFor}
          onClearThread={onClearThread}
          selectedSeq={selectedSeq}
          onSelectSeq={onSelectSeq}
          toolbar
        />
      )
    case 'files':
      return (
        <FilesViewer
          runId={runId}
          folderId={folderId}
          identities={identities}
          onOpenFile={onOpenFile}
        />
      )
    case 'file':
      return (
        <FileViewer
          runId={runId}
          folderId={folderId}
          path={tab.target}
          refreshEpoch={refreshEpoch}
        />
      )
    case 'changes':
      return <ChangesViewer runId={runId} folderId={folderId} refreshEpoch={refreshEpoch} />
    case 'terminal':
      return <TerminalViewer runId={runId} folderId={folderId} cwd={tab.target} />
    case 'browser':
      return <BrowserViewer target={tab.target} folderId={folderId} onRetarget={onRetarget} />
    case 'review':
      return <ReviewViewer runId={runId} />

    default: {
      const exhaustive: never = tab.kind

      return exhaustive
    }
  }
}

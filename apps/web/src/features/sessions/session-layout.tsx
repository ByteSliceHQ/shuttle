import { PanelBottom, PanelRight, Users } from 'lucide-react'

import type { Command } from '@/components/command-palette'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { cn } from '@/lib/cn'
import { useWidthBucket } from '@/lib/use-width-bucket'

import { useSession } from './session'
import { PaneToggle, SessionHeader } from './session-header'
import {
  AGENTS_SHORTCUT,
  ARTIFACTS_SHORTCUT,
  EVENTS_SHORTCUT,
  PALETTE_SHORTCUT,
  shortcutLabel,
  useCollapsiblePanel,
  usePaneShortcuts,
} from './session-panes'
import {
  SessionAgents,
  SessionArtifacts,
  SessionComposer,
  SessionConversation,
  SessionEvents,
  SessionPalette,
} from './session-parts'

/**
 * Session-area widths, in CSS pixels, at which a pane can dock. Below the first only the
 * conversation shows (artifacts open over it); from the second the agents pane can dock too.
 */
const PANE_BREAKPOINTS = [640, 980] as const

type PaneLayout = 'one' | 'two' | 'three'

/**
 * Shuttle's own arrangement of a session: agents, the conversation with its header and message
 * box, and artifacts side by side, with event history in a drawer underneath. Panes dock where
 * there is room and can be dragged, shown and hidden. It is one way to put the parts together;
 * a host that wants another puts them together itself inside `<Shuttle.Session>`.
 */
export function SessionLayout() {
  const { panes } = useSession()
  const [layoutRef, paneCount] = useWidthBucket<HTMLDivElement>(PANE_BREAKPOINTS)
  const layout: PaneLayout = paneCount >= 2 ? 'three' : paneCount === 1 ? 'two' : 'one'

  // In the one-pane layout the artifacts pane opens over the conversation.
  const artifactsOpen = layout === 'one' ? panes.artifactsOverlay : panes.artifacts

  const toggleArtifacts = () => {
    if (layout === 'one') {
      panes.setArtifactsOverlay(!panes.artifactsOverlay)
    } else {
      panes.setArtifacts(!panes.artifacts)
    }
  }

  const commands: Command[] = [
    ...(layout === 'three'
      ? [
          {
            id: 'agents',
            label: panes.agents ? 'Hide agents' : 'Show agents',
            icon: <Users />,
            shortcut: shortcutLabel(AGENTS_SHORTCUT),
            keywords: 'threads tree conductor worker',
            run: () => panes.setAgents(!panes.agents),
          },
        ]
      : []),
    {
      id: 'artifacts',
      label: artifactsOpen ? 'Hide artifacts' : 'Show artifacts',
      icon: <PanelRight />,
      shortcut: shortcutLabel(ARTIFACTS_SHORTCUT),
      keywords: 'panel tabs side',
      run: toggleArtifacts,
    },
    {
      id: 'events',
      label: panes.events ? 'Hide event history' : 'Show event history',
      icon: <PanelBottom />,
      shortcut: shortcutLabel(EVENTS_SHORTCUT),
      keywords: 'debug log inspect',
      run: () => panes.setEvents(!panes.events),
    },
  ]

  const agentsPanel = useCollapsiblePanel({
    open: panes.agents,
    onOpenChange: panes.setAgents,
    preferredSize: '18',
  })

  const artifactsPanel = useCollapsiblePanel({
    open: panes.artifacts,
    onOpenChange: panes.setArtifacts,
    preferredSize: '34',
  })

  const eventsPanel = useCollapsiblePanel({
    open: panes.events,
    onOpenChange: panes.setEvents,
    preferredSize: '38',
  })

  usePaneShortcuts([
    { ...AGENTS_SHORTCUT, run: () => panes.setAgents(!panes.agents) },
    { ...ARTIFACTS_SHORTCUT, run: toggleArtifacts },
    { ...EVENTS_SHORTCUT, run: () => panes.setEvents(!panes.events) },
    { ...PALETTE_SHORTCUT, run: () => panes.setPalette(!panes.palette) },
  ])

  return (
    <div ref={layoutRef} className="flex h-full min-h-0 flex-col">
      <SessionPalette commands={commands} />
      <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
        <ResizablePanel id="session" minSize={160}>
          <ResizablePanelGroup orientation="horizontal" className="h-full min-h-0">
            {layout === 'three' ? (
              <>
                <ResizablePanel
                  id="agents"
                  panelRef={agentsPanel.panelRef}
                  onResize={agentsPanel.onResize}
                  defaultSize={agentsPanel.defaultSize}
                  collapsible
                  collapsedSize={0}
                  minSize={200}
                  maxSize="30"
                >
                  <div inert={!panes.agents} className="h-full min-h-0">
                    <SessionAgents onClose={() => panes.setAgents(false)} />
                  </div>
                </ResizablePanel>
                <ResizableHandle className={panes.agents ? undefined : 'hidden'} />
              </>
            ) : null}
            <ResizablePanel id="conversation" minSize={layout === 'one' ? 0 : 320}>
              <main className="flex h-full min-h-0 flex-col">
                <SessionHeader
                  onShowAgents={layout === 'three' ? () => panes.setAgents(true) : undefined}
                  leading={
                    layout === 'three' && !panes.agents ? (
                      <PaneToggle
                        label="Agents"
                        shortcut={AGENTS_SHORTCUT}
                        open={panes.agents}
                        onToggle={() => panes.setAgents(true)}
                        align="start"
                      >
                        <Users />
                      </PaneToggle>
                    ) : null
                  }
                  trailing={
                    <PaneToggle
                      label="Artifacts"
                      shortcut={ARTIFACTS_SHORTCUT}
                      open={artifactsOpen}
                      onToggle={toggleArtifacts}
                    >
                      <PanelRight />
                    </PaneToggle>
                  }
                />
                {/* Artifacts open over this area in the one-pane layout, under the title bar. */}
                <div className="relative flex min-h-0 flex-1 flex-col">
                  <SessionConversation />
                  <SessionComposer />
                  {layout === 'one' && panes.artifactsOverlay ? (
                    <aside className="bg-background absolute inset-0 z-20 min-h-0">
                      <SessionArtifacts />
                    </aside>
                  ) : null}
                </div>
              </main>
            </ResizablePanel>
            {layout === 'one' ? null : (
              <>
                <ResizableHandle className={panes.artifacts ? undefined : 'hidden'} />
                <ResizablePanel
                  id="artifacts"
                  panelRef={artifactsPanel.panelRef}
                  onResize={artifactsPanel.onResize}
                  defaultSize={artifactsPanel.defaultSize}
                  collapsible
                  collapsedSize={0}
                  minSize={280}
                >
                  <aside inert={!panes.artifacts} aria-label="Artifacts" className="h-full min-h-0">
                    <SessionArtifacts />
                  </aside>
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
        </ResizablePanel>
        <ResizableHandle
          className={cn(
            'h-px w-full after:inset-x-0 after:inset-y-auto after:top-1/2 after:left-0 after:h-2 after:w-full after:translate-x-0 after:-translate-y-1/2',
            !panes.events && 'hidden',
          )}
        />
        <ResizablePanel
          id="events"
          panelRef={eventsPanel.panelRef}
          onResize={eventsPanel.onResize}
          defaultSize={eventsPanel.defaultSize}
          collapsible
          collapsedSize={0}
          minSize={180}
          maxSize="80"
        >
          <section
            inert={!panes.events}
            aria-label="Event history"
            className="bg-sidebar h-full min-h-0"
          >
            <SessionEvents onClose={() => panes.setEvents(false)} />
          </section>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}

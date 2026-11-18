import { Copy, Users, X } from 'lucide-react'
import type { ReactNode } from 'react'

import { CommandPalette, type Command } from '../../components/command-palette'
import { Button } from '../../components/ui/button'
import { PanelHeader, PanelTitle } from '../../components/ui/panel'
import { ArtifactPane } from '../artifacts/artifact-pane'
import { launchableArtifactTypes } from '../artifacts/artifact-types'
import { EventStream } from '../events/event-stream'
import { AgentTree } from './agent-tree'
import { Composer } from './composer'
import { Conversation } from './conversation'
import { useSession } from './session'
import { SessionContextButtons } from './session-context'
import { SessionRepos } from './session-repos'

/**
 * The session's agents, as a tree. Picking one opens its timeline; event history, when it is
 * open, follows along.
 */
export function SessionAgents({
  onClose,
}: {
  /** Adds a close button to the header. */
  onClose?: () => void
}) {
  const session = useSession()

  return (
    <aside aria-label="Agents" className="bg-sidebar flex h-full min-h-0 flex-col">
      <PanelHeader className="pr-2">
        <Users className="text-muted-foreground size-3.5" />
        <PanelTitle meta={session.identities.size > 0 ? session.identities.size : undefined}>
          Agents
        </PanelTitle>
        {onClose ? (
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            aria-label="Close agents"
            onClick={onClose}
          >
            <X />
          </Button>
        ) : null}
      </PanelHeader>
      <AgentTree
        root={session.root}
        activityState={session.activity}
        identities={session.identities}
        eventCounts={session.eventCounts}
        totalEventCount={session.events.length}
        selectedThreadId={session.openThreadId ?? session.inspected.threadId}
        showCounts={session.panes.events}
        onSelect={(threadId) => {
          session.selectThread(threadId)
          session.selectEvent(undefined)
          session.openThread(threadId)
        }}
        stopIn={session.runId}
      />
    </aside>
  )
}

/** The conversation: the session's top level, or the open agent's own timeline. */
export function SessionConversation() {
  const session = useSession()

  return (
    <Conversation
      runId={session.runId}
      feed={session.feed}
      activity={session.activity}
      streaming={session.streaming}
      identities={session.identities}
      onInspect={session.inspect}
      onOpenArtifact={session.openArtifact}
      root={session.root}
      openThreadId={session.openThreadId}
      onOpenThread={session.openThread}
    />
  )
}

/** The message box. Messages go to the open agent while one is, unless the sender picks. */
export function SessionComposer({
  context,
}: {
  /**
   * What the session works from, shown under the box on the left. Left out, it is the folder's
   * repositories and the brief.
   */
  context?: ReactNode
}) {
  const session = useSession()
  const { folder } = session

  return (
    <Composer
      runId={session.runId}
      identities={session.identities}
      disabled={session.summary.finished}
      showExamples={!session.feed.items.some((item) => item.kind === 'user' && !item.goal)}
      targetThreadId={session.openThreadId}
      context={
        context ?? (
          <>
            {folder ? (
              <SessionRepos
                folderId={folder.folderId}
                folderName={folder.name}
                repos={folder.repos}
                align="start"
              />
            ) : null}
            <SessionContextButtons feed={session.feed} />
          </>
        )
      }
    />
  )
}

/** The artifacts pane: a tab for each thing open beside the session, drawn by its type. */
export function SessionArtifacts() {
  const session = useSession()

  return (
    <ArtifactPane
      runId={session.runId}
      folderId={session.folder?.folderId}
      events={session.events}
      media={session.feed.media}
      identities={session.identities}
      controller={session.tabs}
      onReveal={session.panes.revealArtifacts}
      types={session.artifactTypes}
    />
  )
}

/** Every event of the session, or of the agent being inspected. */
export function SessionEvents({
  onClose,
}: {
  /** Adds a close button to the header. */
  onClose?: () => void
}) {
  const session = useSession()
  const { threadId, seq } = session.inspected

  return (
    <EventStream
      events={session.events}
      startedAt={session.summary.startedAt}
      threadId={threadId}
      threadLabel={session.labelFor(threadId ?? null)}
      labelFor={session.labelFor}
      onClearThread={() => session.selectThread(undefined)}
      selectedSeq={seq}
      onSelectSeq={session.selectEvent}
      title="Event history"
      split
      onClose={onClose}
    />
  )
}

/**
 * The session's command palette: everything the default view keeps out of sight, findable by
 * name. It lists a command for each artifact type that can be opened by hand, after any the
 * arrangement adds for its own panes.
 */
export function SessionPalette({ commands = [] }: { commands?: readonly Command[] }) {
  const session = useSession()

  const all: Command[] = [
    ...commands,
    ...launchableArtifactTypes(session.artifactTypes).map((type) => ({
      id: type.kind,
      label: `Open ${type.label.toLowerCase()}`,
      icon: type.icon,
      keywords: type.launcher?.keywords,
      run: () => session.openArtifact(type.kind),
    })),
    {
      id: 'copy-run-id',
      label: 'Copy run ID',
      icon: <Copy />,
      keywords: 'session identifier',
      run: () => void navigator.clipboard.writeText(session.runId),
    },
  ]

  return (
    <CommandPalette
      open={session.panes.palette}
      onOpenChange={session.panes.setPalette}
      commands={all}
    />
  )
}

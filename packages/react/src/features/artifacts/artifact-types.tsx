import {
  FileCode2,
  Files,
  GitCompareArrows,
  Globe,
  Images,
  ListTree,
  SquareTerminal,
} from 'lucide-react'
import type { ReactNode } from 'react'

import type { AgentIdentity } from '../sessions/agents'
import type { SessionMedia } from '../sessions/media'
import type { ArtifactTab, ArtifactTabKind } from '../workspace/workspace'
import { BrowserViewer } from './browser-viewer'
import { MediaViewer } from './media-viewer'
import { ReviewViewer } from './review-viewer'
import { TerminalViewer } from './terminal-viewer'
import { WorkspaceViewer } from './workspace-viewer'

/** What an artifact type is given to draw one of its tabs. */
export interface ArtifactViewProps {
  readonly tab: ArtifactTab
  readonly runId: string
  readonly folderId?: string
  /** The session's files: what people attached and what agents shared. */
  readonly media: readonly SessionMedia[]
  readonly identities: ReadonlyMap<string, AgentIdentity>
  /** Changes each time "go to file" is asked for, for a type that has a file search to open. */
  readonly searchToken: number
  /** Renames the tab and points it somewhere else, as a browser does when it follows a link. */
  readonly retarget: (title: string, target: string) => void
}

/**
 * One kind of tab in the artifacts pane: what it is called, and how it is drawn. The pane knows
 * nothing about any kind beyond what is registered here, so the set a session is given is the
 * set it can show. `<Shuttle.Session artifactTypes={[...defaultArtifactTypes, mine]}>` adds one.
 *
 * A type of the host's own names its kind `<namespace>:<name>`, as in `acme:designs`, which
 * keeps it apart from Shuttle's kinds. The backend keeps such a tab, with its title and its
 * `target`, without knowing what it shows: `target` is the type's to give meaning to (an id, a
 * path, an address).
 */
export interface ArtifactType {
  readonly kind: ArtifactTabKind
  readonly label: string
  readonly icon: ReactNode
  /**
   * There is one tab of this kind at most: opening it again brings the one that is open
   * forward. Left out, each opening is a new tab. Shuttle's own kinds decide this themselves.
   */
  readonly single?: boolean
  /** What a new tab is called, given what it was opened on. Left out, it is the label. */
  readonly title?: (target: string) => string
  /**
   * Offers the type wherever a tab can be opened by hand: the pane's "+" menu and the command
   * palette. Left out, tabs of this kind are only opened by something else, such as a link in
   * a message.
   */
  readonly launcher?: {
    /** More words the command palette finds it by. */
    readonly keywords?: string
    /** Also offered as a button in the empty pane. */
    readonly starter?: boolean
  }
  /** The tab's name in the strip, when it is not the title the tab was saved with. */
  readonly tabLabel?: (tab: ArtifactTab) => string
  readonly render: (props: ArtifactViewProps) => ReactNode
}

/** A file tab's target as a path under the session's worktree, which is how the workspace names files. */
function worktreePath(runId: string, target: string): string {
  const root = `/workspace/.wt/${runId}/`

  return target.startsWith(root) ? target.slice(root.length) : target
}

// One tab shows the workspace. Tabs saved under its earlier names open it too: a Changes tab on
// what changed, a single-file tab on that file.
function workspace({ tab, runId, searchToken }: ArtifactViewProps): ReactNode {
  return (
    <WorkspaceViewer
      key={runId}
      runId={runId}
      searchToken={searchToken}
      initialFilter={tab.kind === 'changes' ? 'changed' : undefined}
      initialPath={tab.kind === 'file' ? worktreePath(runId, tab.target) : undefined}
    />
  )
}

/** The artifact types Shuttle comes with. */
export const defaultArtifactTypes: readonly ArtifactType[] = [
  {
    kind: 'files',
    label: 'Workspace',
    icon: <Files />,
    launcher: { keywords: 'files changes diff code', starter: true },
    // The workspace tab was once called Files, and tabs saved then still say so.
    tabLabel: () => 'Workspace',
    render: workspace,
  },
  {
    kind: 'terminal',
    label: 'Terminal',
    icon: <SquareTerminal />,
    launcher: { keywords: 'shell console', starter: true },
    render: ({ tab, runId, folderId }) => (
      <TerminalViewer runId={runId} folderId={folderId} cwd={tab.target} />
    ),
  },
  {
    kind: 'browser',
    label: 'Browser',
    icon: <Globe />,
    launcher: { keywords: 'preview web page', starter: true },
    render: ({ tab, runId, retarget }) => (
      <BrowserViewer runId={runId} target={tab.target} onRetarget={retarget} />
    ),
  },
  {
    kind: 'review',
    label: 'Review',
    icon: <GitCompareArrows />,
    launcher: { keywords: 'pull request diff' },
    render: ({ runId, folderId }) => <ReviewViewer runId={runId} folderId={folderId} />,
  },
  {
    kind: 'media',
    label: 'Media',
    icon: <Images />,
    launcher: { keywords: 'images video audio files attachments assets generated' },
    render: ({ runId, media, identities }) => (
      <MediaViewer runId={runId} media={media} identities={identities} />
    ),
  },
  { kind: 'changes', label: 'Changes', icon: <GitCompareArrows />, render: workspace },
  { kind: 'file', label: 'File', icon: <FileCode2 />, render: workspace },
  // Event history opens as a drawer under the session; it is never shown as a tab.
  { kind: 'events', label: 'Events', icon: <ListTree />, render: () => null },
]

/** The type that draws tabs of `kind`. The last one registered for a kind wins. */
export function artifactTypeFor(
  types: readonly ArtifactType[],
  kind: string,
): ArtifactType | undefined {
  return types.findLast((type) => type.kind === kind)
}

/** The types a person can open a tab of by hand, in the order they were registered. */
export function launchableArtifactTypes(types: readonly ArtifactType[]): readonly ArtifactType[] {
  return types.filter(
    (type) => type.launcher !== undefined && artifactTypeFor(types, type.kind) === type,
  )
}

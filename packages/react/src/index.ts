/**
 * Shuttle, as a library of React parts. A host makes a `ShuttleHost` for its backend, wraps
 * its pages in `<Shuttle.Provider>`, and puts the parts together however it likes. Shuttle's
 * own web app (`apps/web`) is one such host.
 *
 * `@shuttle/react/ui` has the plain controls the parts are drawn with, and
 * `@shuttle/react/theme.css` the tokens and styles they need.
 */
export * from './parts'
export * from './shuttle'

// The pieces Shuttle's own pages are built from, beyond the session's parts. They are here
// because the app uses them, and stay until each becomes a part with a settled shape.
export { SignInGate, useAgentGate, useStartPlace } from './features/connections/agent-sign-in'
export { ConnectionsPanel } from './features/connections/connections-panel'
export { connectionsQuery } from './features/connections/queries'
export { forgetEventCache } from './features/events/event-cache'
export { eventFamilies, eventMeta, familyColor } from './features/events/event-catalog'
export { EventInspector } from './features/events/event-inspector'
export { EventRow, type EventRowColumns } from './features/events/event-row'
export {
  type GlobalEventFrame,
  type GlobalRunKind,
  latestEventsQuery,
  useGlobalEvents,
} from './features/events/global-events'
export { PlaybookPage } from './features/playbook/playbook-page'
export { playbookQuery } from './features/playbook/playbook-query'
export { PullInboxPanel, PullInboxSheetButton, usePullInbox } from './features/pulls/pull-inbox'
export {
  activitySnapshot,
  attentionChanges,
  attentionCount,
  attentionMessage,
} from './features/sessions/attention'
export { HarnessSwitcher, useDefaultHarness } from './features/sessions/harness-switcher'
export { rememberSession } from './features/sessions/recent-sessions'
export { isSessionUnread, useSeenSessions } from './features/sessions/seen-sessions'
export {
  resolveSessionIndicator,
  sessionIndicatorLabel,
} from './features/sessions/session-activity'
export { sessionQueries } from './features/sessions/session-queries'
export { ActivityDot } from './features/workspace/activity-dot'
export { AppSidebarShell } from './features/workspace/app-sidebar'
export { LinkRepoDialog } from './features/workspace/link-repo-dialog'
export { RepoChip } from './features/workspace/repo-chip'
export { StartAttachments, useStartAttachments } from './features/workspace/start-attachments'
export {
  createWorkspaceFolder,
  orderedFolders,
  preferredFolderId,
  rememberLastFolder,
  repoCountLabel,
  sessionsForFolder,
  startWorkspaceSession,
  type WorkspaceFolder,
  type WorkspaceTree,
} from './features/workspace/workspace'
export { useWorkspace } from './features/workspace/workspace-context'

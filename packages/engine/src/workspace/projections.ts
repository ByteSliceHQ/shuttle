import { Schema } from 'effect'

import { orgOfRun } from '@shuttle/api'

import { isEventOf } from './event-guard'
import { TabKindSchema, workspaceModule, type ArtifactTab } from './scope'
import { mutateSessionTabs, type SessionTabSet } from './tab-set'

function activityEventSeq(
  payloadSeq: number | undefined,
  idempotencyKey: string | null | undefined,
): number | undefined {
  if (payloadSeq !== undefined && Number.isFinite(payloadSeq)) {
    return payloadSeq
  }

  if (idempotencyKey?.startsWith('activity:') === true) {
    const tail = Number(idempotencyKey.slice(idempotencyKey.lastIndexOf(':') + 1))

    if (Number.isFinite(tail)) {
      return tail
    }
  }

  return undefined
}

function isStaleActivityEvent(
  session: { readonly activitySeq?: number; readonly activityAt?: number },
  seq: number | undefined,
  at: number,
): boolean {
  if (seq !== undefined && session.activitySeq !== undefined) {
    return seq < session.activitySeq
  }

  if (session.activityAt !== undefined) {
    return at < session.activityAt
  }

  return false
}

/** Projections re-fold from the event log on read — never stamp wall clock. */
function eventTimestamp(event: { readonly ts?: number }): number {
  return event.ts !== undefined && Number.isFinite(event.ts) ? event.ts : Date.now()
}

/** Reconcile corrections fix a stuck status; they are not new activity, so they never advance the clock. */
function activityEventAt(
  session: { readonly updatedAt: number },
  at: number,
  idempotencyKey: string | null | undefined,
): number {
  return idempotencyKey?.startsWith('reconcile:') === true ? Math.min(at, session.updatedAt) : at
}

const GithubAccountSchema = Schema.Struct({
  login: Schema.String,
  type: Schema.String,
  avatarUrl: Schema.String,
})

const LinkedRepoSchema = Schema.Struct({
  installationId: Schema.Finite,
  owner: Schema.String,
  name: Schema.String,
  fullName: Schema.String,
  defaultBranch: Schema.String,
  private: Schema.Boolean,
})

const FolderSchema = Schema.Struct({
  folderId: Schema.String,
  name: Schema.String,
  createdAt: Schema.Finite,
  archived: Schema.Boolean,
  repos: Schema.Array(LinkedRepoSchema),
  autoReview: Schema.Union([
    Schema.Literal('off'),
    Schema.Literal('others'),
    Schema.Literal('all'),
  ]),
})

const SessionSchema = Schema.Struct({
  runId: Schema.String,
  folderId: Schema.String,
  title: Schema.String,
  goal: Schema.String,
  status: Schema.String,
  activity: Schema.String,
  activitySeq: Schema.optional(Schema.Finite),
  activityAt: Schema.optional(Schema.Finite),
  lastCompletedAt: Schema.optional(Schema.Finite),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
  archived: Schema.Boolean,
  ownerId: Schema.NullOr(Schema.String),
  memberIds: Schema.Array(Schema.String),
})

const InstallationSchema = Schema.Struct({
  installationId: Schema.Finite,
  account: GithubAccountSchema,
})

/** The events the sidebar tree folds; it ignores the rest. */
const TREE_EVENTS = [
  'workspace.folder.created',
  'workspace.folder.renamed',
  'workspace.folder.archived',
  'workspace.folder.reordered',
  'workspace.folder.auto_review.set',
  'workspace.github.connected',
  'workspace.github.disconnected',
  'workspace.repo.linked',
  'workspace.repo.unlinked',
  'workspace.session.requested',
  'workspace.session.listed',
  'workspace.session.unlisted',
  'workspace.session.shared',
  'workspace.session.launched',
  'workspace.session.renamed',
  'workspace.session.archived',
  'workspace.session.activity',
  'runtime.child.settled',
] as const

export const workspaceTree = workspaceModule.projection({
  name: 'workspaceTree',
  shape: Schema.Struct({
    folderOrder: Schema.Array(Schema.String),
    folders: Schema.Record(Schema.String, FolderSchema),
    sessions: Schema.Record(Schema.String, SessionSchema),
    installations: Schema.Record(Schema.String, InstallationSchema),
  }),
  initialState: { folderOrder: [], folders: {}, sessions: {}, installations: {} },
  reduce(state, event) {
    if (!isEventOf(event, TREE_EVENTS)) {
      return state
    }

    switch (event.type) {
      case 'workspace.folder.created': {
        if (state.folders[event.payload.folderId]) {
          return state
        }

        return {
          ...state,
          folderOrder: [...state.folderOrder, event.payload.folderId],
          folders: {
            ...state.folders,
            [event.payload.folderId]: {
              folderId: event.payload.folderId,
              name: event.payload.name,
              createdAt: event.payload.createdAt,
              archived: false,
              repos: [],
              autoReview: 'off' as const,
            },
          },
        }
      }

      case 'workspace.folder.renamed': {
        const folder = state.folders[event.payload.folderId]

        if (!folder) {
          return state
        }

        return {
          ...state,
          folders: {
            ...state.folders,
            [event.payload.folderId]: { ...folder, name: event.payload.name },
          },
        }
      }

      case 'workspace.folder.archived': {
        const folder = state.folders[event.payload.folderId]

        if (!folder) {
          return state
        }

        return {
          ...state,
          folders: {
            ...state.folders,
            [event.payload.folderId]: { ...folder, archived: true },
          },
        }
      }

      case 'workspace.folder.reordered': {
        const known = new Set(state.folderOrder)
        const next = event.payload.folderIds.filter((id) => known.has(id))
        const missing = state.folderOrder.filter((id) => !next.includes(id))
        return { ...state, folderOrder: [...next, ...missing] }
      }

      case 'workspace.folder.auto_review.set': {
        const folder = state.folders[event.payload.folderId]

        if (!folder) {
          return state
        }

        return {
          ...state,
          folders: {
            ...state.folders,
            [folder.folderId]: {
              ...folder,
              autoReview: event.payload.autoReview,
            },
          },
        }
      }

      case 'workspace.github.connected': {
        return {
          ...state,
          installations: {
            ...state.installations,
            [String(event.payload.installationId)]: {
              installationId: event.payload.installationId,
              account: event.payload.account,
            },
          },
        }
      }

      case 'workspace.github.disconnected': {
        const next = { ...state.installations }
        delete next[String(event.payload.installationId)]
        return { ...state, installations: next }
      }

      case 'workspace.repo.linked': {
        const folder = state.folders[event.payload.folderId]

        if (!folder) {
          return state
        }

        if (folder.repos.some((repo) => repo.fullName === event.payload.repo.fullName)) {
          return state
        }

        return {
          ...state,
          folders: {
            ...state.folders,
            [event.payload.folderId]: {
              ...folder,
              repos: [...folder.repos, event.payload.repo],
            },
          },
        }
      }

      case 'workspace.repo.unlinked': {
        const folder = state.folders[event.payload.folderId]

        if (!folder) {
          return state
        }

        return {
          ...state,
          folders: {
            ...state.folders,
            [event.payload.folderId]: {
              ...folder,
              repos: folder.repos.filter((repo) => repo.fullName !== event.payload.fullName),
            },
          },
        }
      }

      case 'workspace.session.requested': {
        if (
          state.sessions[event.payload.runId] ||
          orgOfRun(event.payload.runId) !== orgOfRun(event.runId)
        ) {
          return state
        }

        const at = eventTimestamp(event)

        return {
          ...state,
          sessions: {
            ...state.sessions,
            [event.payload.runId]: {
              runId: event.payload.runId,
              folderId: event.payload.folderId,
              title: event.payload.goal,
              goal: event.payload.goal,
              status: 'requested',
              activity: 'idle',
              createdAt: at,
              updatedAt: at,
              archived: false,
              ownerId: event.payload.ownerId ?? null,
              memberIds: [],
            },
          },
        }
      }

      case 'workspace.session.listed': {
        const { payload } = event

        if (state.sessions[payload.runId] || orgOfRun(payload.runId) !== orgOfRun(event.runId)) {
          return state
        }

        return {
          ...state,
          sessions: {
            ...state.sessions,
            [payload.runId]: {
              runId: payload.runId,
              folderId: payload.folderId,
              title: payload.title,
              goal: payload.goal,
              status: payload.status,
              activity: payload.activity,
              createdAt: payload.createdAt,
              updatedAt: payload.updatedAt,
              archived: payload.archived,
              ownerId: payload.ownerId,
              memberIds: payload.memberIds,
            },
          },
        }
      }

      case 'workspace.session.unlisted': {
        if (!state.sessions[event.payload.runId]) {
          return state
        }

        const { [event.payload.runId]: _removed, ...sessions } = state.sessions

        return { ...state, sessions }
      }

      case 'workspace.session.shared': {
        const session = state.sessions[event.payload.runId]

        if (!session) {
          return state
        }

        return {
          ...state,
          sessions: {
            ...state.sessions,
            [event.payload.runId]: { ...session, memberIds: event.payload.memberIds },
          },
        }
      }

      case 'workspace.session.launched': {
        const session = state.sessions[event.payload.runId]

        if (!session) {
          return state
        }

        return {
          ...state,
          sessions: {
            ...state.sessions,
            [event.payload.runId]: {
              ...session,
              status: 'running',
              activity: 'working',
              updatedAt: eventTimestamp(event),
            },
          },
        }
      }

      case 'workspace.session.renamed': {
        const session = state.sessions[event.payload.runId]

        if (!session) {
          return state
        }

        return {
          ...state,
          sessions: {
            ...state.sessions,
            [event.payload.runId]: {
              ...session,
              title: event.payload.title,
              updatedAt: eventTimestamp(event),
            },
          },
        }
      }

      case 'workspace.session.archived': {
        const session = state.sessions[event.payload.runId]

        if (!session) {
          return state
        }

        return {
          ...state,
          sessions: {
            ...state.sessions,
            [event.payload.runId]: {
              ...session,
              archived: true,
              updatedAt: eventTimestamp(event),
            },
          },
        }
      }

      case 'workspace.session.activity': {
        const session = state.sessions[event.payload.runId]

        if (!session) {
          return state
        }

        const seq = activityEventSeq(event.payload.seq, event.idempotencyKey)
        const at = activityEventAt(session, event.payload.at, event.idempotencyKey)

        if (isStaleActivityEvent(session, seq, at)) {
          return state
        }

        const finishedWork = session.activity === 'working' && event.payload.activity === 'idle'

        return {
          ...state,
          sessions: {
            ...state.sessions,
            [event.payload.runId]: {
              ...session,
              activity: event.payload.activity,
              activityAt: Math.max(session.activityAt ?? 0, at),
              activitySeq:
                seq === undefined ? session.activitySeq : Math.max(session.activitySeq ?? 0, seq),
              updatedAt: Math.max(session.updatedAt, at),
              lastCompletedAt: finishedWork ? at : session.lastCompletedAt,
            },
          },
        }
      }

      case 'runtime.child.settled': {
        const { runId, status } = event.payload

        if (runId === '') {
          return state
        }

        const session = state.sessions[runId]

        if (!session) {
          return state
        }

        const nextStatus = status
        const at = eventTimestamp(event)

        return {
          ...state,
          sessions: {
            ...state.sessions,
            [runId]: {
              ...session,
              status: nextStatus,
              activity: nextStatus === 'failed' ? 'error' : 'idle',
              updatedAt: at,
              lastCompletedAt: nextStatus === 'completed' ? at : session.lastCompletedAt,
            },
          },
        }
      }
    }
  },
})

const TabSchema = Schema.Struct({
  tabId: Schema.String,
  kind: TabKindSchema,
  title: Schema.String,
  target: Schema.String,
  openedAt: Schema.Finite,
})

const SessionTabSetSchema = Schema.Struct({
  order: Schema.Array(Schema.String),
  tabs: Schema.Record(Schema.String, TabSchema),
})

export type { ArtifactTab, SessionTabSet }

export type SessionTabsState = Readonly<Record<string, SessionTabSet>>

/** The events the session tab sets fold; they ignore the rest. */
const TAB_EVENTS = [
  'workspace.tab.opened',
  'workspace.tab.closed',
  'workspace.tab.reordered',
  'workspace.tab.retargeted',
] as const

export const sessionTabs = workspaceModule.projection({
  name: 'sessionTabs',
  shape: Schema.Record(Schema.String, SessionTabSetSchema),
  initialState: {},
  reduce(state, event) {
    if (!isEventOf(event, TAB_EVENTS)) {
      return state
    }

    switch (event.type) {
      case 'workspace.tab.opened': {
        const { runId, tabId, kind, title, target, at } = event.payload

        return mutateSessionTabs(state, runId, {
          type: 'open',
          tab: { tabId, kind, title, target, openedAt: at },
        })
      }

      case 'workspace.tab.closed': {
        return mutateSessionTabs(state, event.payload.runId, {
          type: 'close',
          tabId: event.payload.tabId,
        })
      }

      case 'workspace.tab.reordered': {
        return mutateSessionTabs(state, event.payload.runId, {
          type: 'reorder',
          tabIds: event.payload.tabIds,
        })
      }

      case 'workspace.tab.retargeted': {
        const { runId, tabId, title, target } = event.payload

        return mutateSessionTabs(state, runId, { type: 'retarget', tabId, title, target })
      }
    }
  },
})

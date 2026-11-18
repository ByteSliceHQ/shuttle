import type {
  ArtifactTabKind,
  SessionTabsState,
  WorkspaceFolder,
  WorkspaceSession,
  WorkspaceTree,
} from '@shuttle/api'
import { defineProjection } from '@swirls/looms/core'

import { type ShuttleHost } from '../../shuttle'
import { isNamespaceEvent } from '../events/namespace-events'
import type { WorkspaceEvent } from '../events/shuttle-events'
import { mutateSessionTabs } from '../sessions/tab-set'

// The workspace's shapes are the Worker's contract. They are passed on from here because this
// is where the rest of the app has always looked for them.
export type {
  ArtifactTab,
  ArtifactTabKind,
  GithubInstallation,
  LinkedRepo,
  SessionTabSet,
  SessionTabsState,
  WorkspaceFolder,
  WorkspaceSession,
  WorkspaceSnapshot,
  WorkspaceSnapshotResponse,
  WorkspaceTree,
} from '@shuttle/api'

export const emptyWorkspaceTree: WorkspaceTree = {
  folderOrder: [],
  folders: {},
  sessions: {},
  installations: {},
}

export const emptySessionTabs: SessionTabsState = {}

/** The event's own timestamp when it carries a usable one, else now. */
function eventTime(ts: number | undefined): number {
  return ts !== undefined && Number.isFinite(ts) ? ts : Date.now()
}

function activityEventSeq(
  payloadSeq: number | undefined,
  idempotencyKey: string | null | undefined,
): number | undefined {
  if (payloadSeq !== undefined && Number.isFinite(payloadSeq)) {
    return payloadSeq
  }

  if (
    idempotencyKey !== null &&
    idempotencyKey !== undefined &&
    idempotencyKey.startsWith('activity:')
  ) {
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

/** Reconcile corrections fix a stuck status; they are not new activity, so they never advance the clock. */
function activityEventAt(
  session: { readonly updatedAt: number },
  at: number,
  idempotencyKey: string | null | undefined,
): number {
  return idempotencyKey !== null &&
    idempotencyKey !== undefined &&
    idempotencyKey.startsWith('reconcile:')
    ? Math.min(at, session.updatedAt)
    : at
}

export const workspaceTree = defineProjection<WorkspaceTree, WorkspaceEvent>({
  name: 'workspaceTree',
  initialState: emptyWorkspaceTree,
  reduce(state, event) {
    if (event.type === 'runtime.child.settled') {
      const payload = event.payload

      if (payload.runId === '') {
        return state
      }

      const session = state.sessions[payload.runId]

      if (!session) {
        return state
      }

      const nextStatus = payload.status
      const at = eventTime(event.ts)

      const nextSession: WorkspaceSession = {
        ...session,
        status: nextStatus,
        activity: nextStatus === 'failed' ? 'error' : 'idle',
        updatedAt: at,
      }

      if (nextStatus === 'completed') {
        nextSession.lastCompletedAt = at
      }

      return { ...state, sessions: { ...state.sessions, [payload.runId]: nextSession } }
    }

    if (!isNamespaceEvent(event, 'workspace')) {
      return state
    }

    switch (event.type) {
      case 'workspace.folder.created': {
        const payload = event.payload

        if (state.folders[payload.folderId]) {
          return state
        }

        return {
          ...state,
          folderOrder: [...state.folderOrder, payload.folderId],
          folders: {
            ...state.folders,
            [payload.folderId]: {
              folderId: payload.folderId,
              name: payload.name,
              createdAt: payload.createdAt,
              archived: false,
              repos: [],
              autoReview: 'off',
            },
          },
        }
      }

      case 'workspace.folder.renamed': {
        const payload = event.payload
        const folder = state.folders[payload.folderId]

        if (!folder) {
          return state
        }

        return {
          ...state,
          folders: {
            ...state.folders,
            [payload.folderId]: { ...folder, name: payload.name },
          },
        }
      }

      case 'workspace.folder.auto_review.set': {
        const payload = event.payload

        const folder = state.folders[payload.folderId]

        if (!folder) {
          return state
        }

        return {
          ...state,
          folders: {
            ...state.folders,
            [payload.folderId]: { ...folder, autoReview: payload.autoReview },
          },
        }
      }

      case 'workspace.folder.archived': {
        const payload = event.payload
        const folder = state.folders[payload.folderId]

        if (!folder) {
          return state
        }

        return {
          ...state,
          folders: {
            ...state.folders,
            [payload.folderId]: { ...folder, archived: true },
          },
        }
      }

      case 'workspace.folder.reordered': {
        const payload = event.payload
        const known = new Set(state.folderOrder)
        const next = payload.folderIds.filter((id) => known.has(id))
        const missing = state.folderOrder.filter((id) => !next.includes(id))
        return { ...state, folderOrder: [...next, ...missing] }
      }

      case 'workspace.github.connected': {
        const payload = event.payload

        return {
          ...state,
          installations: {
            ...state.installations,
            [String(payload.installationId)]: {
              installationId: payload.installationId,
              account: payload.account,
            },
          },
        }
      }

      case 'workspace.github.disconnected': {
        const payload = event.payload
        const next = { ...state.installations }
        delete next[String(payload.installationId)]
        return { ...state, installations: next }
      }

      case 'workspace.repo.linked': {
        const payload = event.payload
        const folder = state.folders[payload.folderId]

        if (!folder) {
          return state
        }

        if (folder.repos.some((repo) => repo.fullName === payload.repo.fullName)) {
          return state
        }

        return {
          ...state,
          folders: {
            ...state.folders,
            [payload.folderId]: {
              ...folder,
              repos: [...folder.repos, payload.repo],
            },
          },
        }
      }

      case 'workspace.repo.unlinked': {
        const payload = event.payload
        const folder = state.folders[payload.folderId]

        if (!folder) {
          return state
        }

        return {
          ...state,
          folders: {
            ...state.folders,
            [payload.folderId]: {
              ...folder,
              repos: folder.repos.filter((repo) => repo.fullName !== payload.fullName),
            },
          },
        }
      }

      case 'workspace.session.requested': {
        const payload = event.payload

        if (state.sessions[payload.runId]) {
          return state
        }

        const now = eventTime(event.ts)

        return {
          ...state,
          sessions: {
            ...state.sessions,
            [payload.runId]: {
              runId: payload.runId,
              folderId: payload.folderId,
              title: payload.goal,
              goal: payload.goal,
              status: 'requested',
              activity: 'idle',
              createdAt: now,
              updatedAt: now,
              archived: false,
              ownerId: payload.ownerId ?? null,
              memberIds: [],
            },
          },
        }
      }

      case 'workspace.session.shared': {
        const payload = event.payload
        const session = state.sessions[payload.runId]

        if (!session) {
          return state
        }

        return {
          ...state,
          sessions: {
            ...state.sessions,
            [payload.runId]: { ...session, memberIds: payload.memberIds },
          },
        }
      }

      case 'workspace.session.launched': {
        const payload = event.payload
        const session = state.sessions[payload.runId]

        if (!session) {
          return state
        }

        const at = eventTime(event.ts)

        return {
          ...state,
          sessions: {
            ...state.sessions,
            [payload.runId]: {
              ...session,
              status: 'running',
              activity: 'working',
              updatedAt: at,
            },
          },
        }
      }

      case 'workspace.session.renamed': {
        const payload = event.payload
        const session = state.sessions[payload.runId]

        if (!session) {
          return state
        }

        const at = eventTime(event.ts)

        return {
          ...state,
          sessions: {
            ...state.sessions,
            [payload.runId]: {
              ...session,
              title: payload.title,
              updatedAt: at,
            },
          },
        }
      }

      case 'workspace.session.archived': {
        const payload = event.payload
        const session = state.sessions[payload.runId]

        if (!session) {
          return state
        }

        const at = eventTime(event.ts)

        return {
          ...state,
          sessions: {
            ...state.sessions,
            [payload.runId]: {
              ...session,
              archived: true,
              updatedAt: at,
            },
          },
        }
      }

      case 'workspace.session.activity': {
        const payload = event.payload

        const session = state.sessions[payload.runId]

        if (!session) {
          return state
        }

        const seq = activityEventSeq(payload.seq, event.idempotencyKey)
        const at = activityEventAt(session, payload.at, event.idempotencyKey)

        if (isStaleActivityEvent(session, seq, at)) {
          return state
        }

        const finishedWork = session.activity === 'working' && payload.activity === 'idle'

        const nextSession: WorkspaceSession = {
          ...session,
          activity: payload.activity,
          activityAt: Math.max(session.activityAt ?? 0, at),
          updatedAt: Math.max(session.updatedAt, at),
        }

        if (seq !== undefined) {
          nextSession.activitySeq = Math.max(session.activitySeq ?? 0, seq)
        }

        if (finishedWork) {
          nextSession.lastCompletedAt = at
        }

        return {
          ...state,
          sessions: { ...state.sessions, [payload.runId]: nextSession },
        }
      }

      case 'workspace.session.listed':
      case 'workspace.session.unlisted':
      case 'workspace.tab.opened':
      case 'workspace.tab.closed':
      case 'workspace.tab.reordered':
      case 'workspace.tab.retargeted':
        return state
    }
  },
})

export const sessionTabs = defineProjection<SessionTabsState, WorkspaceEvent>({
  name: 'sessionTabs',
  initialState: emptySessionTabs,
  reduce(state, event) {
    if (!isNamespaceEvent(event, 'workspace')) {
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

      case 'workspace.folder.created':
      case 'workspace.folder.renamed':
      case 'workspace.folder.auto_review.set':
      case 'workspace.folder.archived':
      case 'workspace.folder.reordered':
      case 'workspace.github.connected':
      case 'workspace.github.disconnected':
      case 'workspace.repo.linked':
      case 'workspace.repo.unlinked':
      case 'workspace.session.requested':
      case 'workspace.session.shared':
      case 'workspace.session.launched':
      case 'workspace.session.renamed':
      case 'workspace.session.archived':
      case 'workspace.session.activity':
      case 'workspace.session.listed':
      case 'workspace.session.unlisted':
        return state
    }
  },
})

/**
 * On a host with a machine (the desktop app) a new session starts on this machine whenever its sandbox is up. It can be
 * moved to the cloud from the session's title bar at any point after that.
 */
async function startsOnThisMachine(host: ShuttleHost): Promise<{ deviceId?: string }> {
  const app = host.device

  if (!app) {
    return {}
  }

  const [runner, wanted] = await Promise.all([
    app.runnerStatus().catch(() => null),
    app.startsLocally().catch(() => true),
  ])

  return wanted && runner?.status === 'online' ? { deviceId: app.deviceId } : {}
}

/**
 * Starts a session in a folder, on this machine when the desktop app has its sandbox up. Files
 * go with the request, so the session's first task already has them.
 */
export async function startWorkspaceSession(
  host: ShuttleHost,
  input: { folderId: string; goal: string; files?: readonly File[] },
): Promise<{ runId: string }> {
  const { files = [], ...fields } = input

  return host.client.workspace.createSession({
    ...fields,
    files: files.length > 0 ? [...files] : undefined,
    ...(await startsOnThisMachine(host)),
  })
}

export async function createWorkspaceFolder(host: ShuttleHost, runId: string, name: string) {
  const folderId = crypto.randomUUID()

  await host.signalRun(runId, 'workspace/createFolder', {
    folderId,
    name,
    createdAt: Date.now(),
  })

  return folderId
}

export async function renameWorkspaceFolder(
  host: ShuttleHost,
  runId: string,
  folderId: string,
  name: string,
) {
  await host.signalRun(runId, 'workspace/renameFolder', { folderId, name })
}

export async function archiveWorkspaceFolder(host: ShuttleHost, runId: string, folderId: string) {
  await host.signalRun(runId, 'workspace/archiveFolder', { folderId })
}

export async function openSessionTab(
  host: ShuttleHost,
  workspaceRunId: string,
  input: {
    runId: string
    tabId: string
    kind: ArtifactTabKind
    title: string
    target: string
    at?: number
  },
) {
  await host.signalRun(workspaceRunId, 'workspace/openTab', {
    ...input,
    at: input.at ?? Date.now(),
  })
}

export async function closeSessionTab(
  host: ShuttleHost,
  workspaceRunId: string,
  input: { runId: string; tabId: string },
) {
  await host.signalRun(workspaceRunId, 'workspace/closeTab', input)
}

export async function reorderSessionTabs(
  host: ShuttleHost,
  workspaceRunId: string,
  input: { runId: string; tabIds: string[] },
) {
  await host.signalRun(workspaceRunId, 'workspace/reorderTabs', input)
}

export async function retargetSessionTab(
  host: ShuttleHost,
  workspaceRunId: string,
  input: { runId: string; tabId: string; title: string; target: string },
) {
  await host.signalRun(workspaceRunId, 'workspace/retargetTab', input)
}

/** Links repositories to a folder one after another, stopping at the first the Worker refuses. */
export async function linkFolderRepos(
  host: ShuttleHost,
  folderId: string,
  repos: readonly { installationId: number; owner: string; name: string }[],
) {
  for (const repo of repos) {
    await host.client.workspace.repos.link({
      folderId,
      installationId: repo.installationId,
      owner: repo.owner,
      name: repo.name,
    })
  }
}

export function sessionsForFolder(
  tree: WorkspaceTree,
  folderId: string,
  options?: { includeArchived?: boolean },
): WorkspaceSession[] {
  return Object.values(tree.sessions)
    .filter(
      (session) =>
        session.folderId === folderId && (options?.includeArchived === true || !session.archived),
    )
    .toSorted((left, right) => right.updatedAt - left.updatedAt)
}

export function orderedFolders(
  tree: WorkspaceTree,
  options?: { includeArchived?: boolean },
): WorkspaceFolder[] {
  return tree.folderOrder
    .map((id) => tree.folders[id])
    .filter((folder): folder is WorkspaceFolder => Boolean(folder))
    .filter((folder) => options?.includeArchived === true || !folder.archived)
}

const SESSION_STATUS_LABELS = new Map([
  ['requested', 'Starting'],
  ['running', 'Running'],
  ['completed', 'Completed'],
  ['failed', 'Failed'],
  ['cancelled', 'Cancelled'],
])

export function sessionStatusLabel(status: string): string {
  return SESSION_STATUS_LABELS.get(status) ?? status
}

export function repoCountLabel(count: number): string {
  return count === 1 ? '1 linked repo' : `${count} linked repos`
}

const LAST_FOLDER_KEY = 'shuttle.last-folder'

export function rememberLastFolder(folderId: string) {
  localStorage.setItem(LAST_FOLDER_KEY, folderId)
}

export function lastFolderId(): string | null {
  return localStorage.getItem(LAST_FOLDER_KEY)
}

/** The last folder the user worked in, else the first active one. */
export function preferredFolderId(tree: WorkspaceTree): string | null {
  const remembered = lastFolderId()

  const folder = remembered === null ? undefined : tree.folders[remembered]

  if (remembered !== null && folder !== undefined && !folder.archived) {
    return remembered
  }

  return orderedFolders(tree)[0]?.folderId ?? null
}

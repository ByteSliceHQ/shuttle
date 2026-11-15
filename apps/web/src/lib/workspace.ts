import { defineProjection } from '@swirls/looms/core'

import type { WorkspaceEvent } from './shuttle-events'
import { mutateSessionTabs } from './tab-set'

export interface LinkedRepo {
  readonly installationId: number
  readonly owner: string
  readonly name: string
  readonly fullName: string
  readonly defaultBranch: string
  readonly private: boolean
}

export type FolderAutoReview = 'off' | 'others' | 'all'

export interface WorkspaceFolder {
  readonly folderId: string
  readonly name: string
  readonly createdAt: number
  readonly archived: boolean
  readonly repos: readonly LinkedRepo[]
  readonly autoReview?: FolderAutoReview
}

export interface WorkspaceSession {
  readonly runId: string
  readonly folderId: string
  readonly title: string
  readonly goal: string
  readonly status: string
  readonly activity: string
  readonly activitySeq?: number
  readonly activityAt?: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly archived: boolean
  readonly lastCompletedAt?: number
  readonly unread?: boolean
  /** The person who started the session. Null or absent when Shuttle started it. */
  readonly ownerId?: string | null
  /** People the owner shared the session with. */
  readonly memberIds?: readonly string[]
}

export interface GithubInstallation {
  readonly installationId: number
  readonly account: {
    readonly login: string
    readonly type: string
    readonly avatarUrl: string
  }
}

export interface WorkspaceTree {
  readonly folderOrder: readonly string[]
  readonly folders: Readonly<Record<string, WorkspaceFolder>>
  readonly sessions: Readonly<Record<string, WorkspaceSession>>
  readonly installations: Readonly<Record<string, GithubInstallation>>
}

export type ArtifactTabKind =
  | 'events'
  | 'files'
  | 'file'
  | 'changes'
  | 'terminal'
  | 'browser'
  | 'review'
  | 'media'

export interface ArtifactTab {
  readonly tabId: string
  readonly kind: ArtifactTabKind
  readonly title: string
  readonly target: string
  readonly openedAt: number
}

export interface SessionTabSet {
  readonly order: readonly string[]
  readonly tabs: Readonly<Record<string, ArtifactTab>>
}

export type SessionTabsState = Readonly<Record<string, SessionTabSet>>

export const emptyWorkspaceTree: WorkspaceTree = {
  folderOrder: [],
  folders: {},
  sessions: {},
  installations: {},
}

export const emptySessionTabs: SessionTabsState = {}

function activityEventSeq(
  payloadSeq: number | undefined,
  idempotencyKey: string | null | undefined,
): number | undefined {
  if (typeof payloadSeq === 'number' && Number.isFinite(payloadSeq)) {
    return payloadSeq
  }

  if (typeof idempotencyKey === 'string' && idempotencyKey.startsWith('activity:')) {
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
  return typeof idempotencyKey === 'string' && idempotencyKey.startsWith('reconcile:')
    ? Math.min(at, session.updatedAt)
    : at
}

export const workspaceTree = defineProjection<WorkspaceTree, WorkspaceEvent>({
  name: 'workspaceTree',
  initialState: emptyWorkspaceTree,
  reduce(state, event) {
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

        const now =
          typeof event.ts === 'number' && Number.isFinite(event.ts) ? event.ts : Date.now()

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

        const at = typeof event.ts === 'number' && Number.isFinite(event.ts) ? event.ts : Date.now()

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

        const at = typeof event.ts === 'number' && Number.isFinite(event.ts) ? event.ts : Date.now()

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

        const at = typeof event.ts === 'number' && Number.isFinite(event.ts) ? event.ts : Date.now()

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

        return {
          ...state,
          sessions: {
            ...state.sessions,
            [payload.runId]: {
              ...session,
              activity: payload.activity,
              activityAt: Math.max(session.activityAt ?? 0, at),
              ...(seq !== undefined
                ? { activitySeq: Math.max(session.activitySeq ?? 0, seq) }
                : {}),
              updatedAt: Math.max(session.updatedAt, at),
              ...(finishedWork ? { lastCompletedAt: at } : {}),
            },
          },
        }
      }

      case 'runtime.child.settled': {
        const payload = event.payload
        const runId = typeof payload.runId === 'string' ? payload.runId : null

        if (!runId) {
          return state
        }

        const session = state.sessions[runId]

        if (!session) {
          return state
        }

        const nextStatus = payload.status ?? session.status
        const at = typeof event.ts === 'number' && Number.isFinite(event.ts) ? event.ts : Date.now()

        return {
          ...state,
          sessions: {
            ...state.sessions,
            [runId]: {
              ...session,
              status: nextStatus,
              activity: nextStatus === 'failed' ? 'error' : 'idle',
              updatedAt: at,
              ...(nextStatus === 'completed' ? { lastCompletedAt: at } : {}),
            },
          },
        }
      }

      default:
        return state
    }
  },
})

export const sessionTabs = defineProjection<SessionTabsState, WorkspaceEvent>({
  name: 'sessionTabs',
  initialState: emptySessionTabs,
  reduce(state, event) {
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

      default:
        return state
    }
  },
})

async function postJson(path: string, body: object): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export interface WorkspaceSnapshot {
  readonly runId: string
  readonly tail?: number
  readonly tree?: WorkspaceTree | null
  readonly tabs?: SessionTabsState | null
}

/** The organization's workspace, and inside it the caller's own. */
export interface WorkspaceSnapshotResponse extends WorkspaceSnapshot {
  readonly personal: WorkspaceSnapshot
}

export async function fetchWorkspace(): Promise<WorkspaceSnapshotResponse> {
  const response = await fetch('/workspace')

  if (!response.ok) {
    throw new Error(`Failed to load workspace: ${response.status}`)
  }

  return (await response.json()) as WorkspaceSnapshotResponse
}

export async function startWorkspaceSession(input: {
  folderId: string
  goal: string
}): Promise<{ runId: string }> {
  const response = await postJson('/workspace/sessions', input)

  if (!response.ok) {
    throw new Error(`Failed to start session: ${response.status} ${await response.text()}`)
  }

  return (await response.json()) as { runId: string }
}

export async function signalWorkspace(runId: string, name: string, input: object) {
  const response = await postJson(`/runs/${runId}/signals/${name}`, { input })

  if (!response.ok) {
    throw new Error(`Workspace signal failed: ${response.status} ${await response.text()}`)
  }
}

export async function createWorkspaceFolder(runId: string, name: string) {
  const folderId = crypto.randomUUID()

  await signalWorkspace(runId, 'workspace/createFolder', {
    folderId,
    name,
    createdAt: Date.now(),
  })

  return folderId
}

export async function renameWorkspaceFolder(runId: string, folderId: string, name: string) {
  await signalWorkspace(runId, 'workspace/renameFolder', { folderId, name })
}

export async function archiveWorkspaceFolder(runId: string, folderId: string) {
  await signalWorkspace(runId, 'workspace/archiveFolder', { folderId })
}

/** Renames a session wherever it is listed. */
export async function renameWorkspaceSession(sessionRunId: string, title: string) {
  const response = await postJson(`/sessions/${encodeURIComponent(sessionRunId)}/rename`, { title })

  if (!response.ok) {
    throw new Error(`Failed to rename session: ${response.status} ${await response.text()}`)
  }
}

/** Archives a session wherever it is listed. */
export async function archiveWorkspaceSession(sessionRunId: string) {
  const response = await postJson(`/sessions/${encodeURIComponent(sessionRunId)}/archive`, {})

  if (!response.ok) {
    throw new Error(`Failed to archive session: ${response.status} ${await response.text()}`)
  }
}

export async function openSessionTab(
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
  await signalWorkspace(workspaceRunId, 'workspace/openTab', {
    ...input,
    at: input.at ?? Date.now(),
  })
}

export async function closeSessionTab(
  workspaceRunId: string,
  input: { runId: string; tabId: string },
) {
  await signalWorkspace(workspaceRunId, 'workspace/closeTab', input)
}

export async function reorderSessionTabs(
  workspaceRunId: string,
  input: { runId: string; tabIds: string[] },
) {
  await signalWorkspace(workspaceRunId, 'workspace/reorderTabs', input)
}

export async function retargetSessionTab(
  workspaceRunId: string,
  input: { runId: string; tabId: string; title: string; target: string },
) {
  await signalWorkspace(workspaceRunId, 'workspace/retargetTab', input)
}

export async function linkFolderRepos(
  folderId: string,
  repos: { installationId: number; owner: string; name: string }[],
) {
  for (const repo of repos) {
    const response = await postJson(
      `/workspace/folders/${encodeURIComponent(folderId)}/repos`,
      repo,
    )

    if (!response.ok) {
      throw new Error(`Failed to link repo: ${response.status} ${await response.text()}`)
    }
  }
}

export async function unlinkFolderRepo(folderId: string, fullName: string) {
  const response = await fetch(`/workspace/folders/${encodeURIComponent(folderId)}/repos`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fullName }),
  })

  if (!response.ok) {
    throw new Error(`Failed to unlink repo: ${response.status} ${await response.text()}`)
  }
}

export async function searchGithubRepos(query: string): Promise<LinkedRepo[]> {
  const response = await fetch(`/github/repos?q=${encodeURIComponent(query)}`)

  if (!response.ok) {
    return []
  }

  const body = (await response.json()) as { repos?: LinkedRepo[] }
  return body.repos ?? []
}

export function sessionsForFolder(
  tree: WorkspaceTree,
  folderId: string,
  options?: { includeArchived?: boolean },
): WorkspaceSession[] {
  return Object.values(tree.sessions)
    .filter(
      (session) => session.folderId === folderId && (options?.includeArchived || !session.archived),
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
    .filter((folder) => options?.includeArchived || !folder.archived)
}

const SESSION_STATUS_LABELS: Record<string, string> = {
  requested: 'Starting',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

export function sessionStatusLabel(status: string): string {
  return SESSION_STATUS_LABELS[status] ?? status
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

  if (remembered && tree.folders[remembered] && !tree.folders[remembered]?.archived) {
    return remembered
  }

  return orderedFolders(tree)[0]?.folderId ?? null
}

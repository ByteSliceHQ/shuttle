import {
  cleanUndefined,
  createWaitId,
  emit,
  launch,
  wait,
  isJsonString,
  type JsonValue,
  type RuntimeEffect,
  type ThreadDefinition,
} from '@swirls/looms/core'

import { jsonObject } from '../json'
import type { AttachmentRef } from '../session/scope'
import { orgOfRun } from '../tenancy/run-id'
import { isEventOf } from './event-guard'
import type { LinkedRepo, SessionActivity } from './scope'
import { NO_FOLDER, workspaceModule } from './scope'

export type AutoReviewMode = 'off' | 'others' | 'all'

export interface WorkspaceFolder {
  readonly folderId: string
  readonly name: string
  readonly createdAt: number
  readonly archived: boolean
  readonly repos: readonly LinkedRepo[]
  readonly autoReview: AutoReviewMode
}

export interface SessionPullRef {
  readonly fullName: string
  readonly number: number
  readonly headSha: string
  readonly baseSha: string
}

export interface WorkspaceSession {
  readonly runId: string
  readonly folderId: string
  readonly attachments?: readonly AttachmentRef[]
  readonly goal: string
  readonly title: string
  readonly status: 'requested' | 'running' | 'completed' | 'failed' | 'cancelled'
  readonly activity: SessionActivity
  readonly activitySeq?: number
  readonly activityAt?: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly archived: boolean
  readonly launched: boolean
  readonly lessons: readonly { id: string; text: string; scope?: string }[]
  readonly playbookVersion: number
  readonly playbookRunId: string | null
  readonly definitionName: string
  readonly pull: SessionPullRef | null
  /** What the host that started the session attached to it. Absent for a session Shuttle started. */
  readonly hostMetadata?: Readonly<Record<string, string>>
  /** The person who started the session. Null when Shuttle started it. */
  readonly ownerId: string | null
  /** People the owner shared the session with. */
  readonly memberIds: readonly string[]
  /** The repositories to launch with, when the request carried them. */
  readonly repos?: readonly LinkedRepo[]
}

const SESSION_STATUSES = ['requested', 'running', 'completed', 'failed', 'cancelled'] as const

function asSessionStatus(value: string): WorkspaceSession['status'] {
  return SESSION_STATUSES.find((status) => status === value) ?? 'running'
}

export interface GithubInstallation {
  readonly installationId: number
  readonly account: {
    readonly login: string
    readonly type: string
    readonly avatarUrl: string
  }
}

export interface WorkspaceState {
  readonly title: string
  readonly folderOrder: readonly string[]
  readonly folders: Readonly<Record<string, WorkspaceFolder>>
  readonly sessions: Readonly<Record<string, WorkspaceSession>>
  readonly installations: Readonly<Record<string, GithubInstallation>>
  readonly mailboxEpoch: number
}

function asString(value: JsonValue | undefined): string | null {
  return isJsonString(value) ? value : null
}

function sandboxNameFor(folderId: string): string {
  return `folder:${folderId}`
}

/** A folder's sandbox is shared by its sessions. A session with no folder has one of its own. */
function sandboxNameOfSession(session: {
  readonly runId: string
  readonly folderId: string
}): string {
  return session.folderId === NO_FOLDER
    ? `session:${session.runId}`
    : sandboxNameFor(session.folderId)
}

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

/** Thread state can be replayed — stamp from the event, not wall clock. */
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

/** The events the workspace thread folds into its state; it ignores the rest. */
const STEPPED_EVENTS = [
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
  'workspace.session.launched',
  'workspace.session.renamed',
  'workspace.session.listed',
  'workspace.session.unlisted',
  'workspace.session.shared',
  'workspace.session.archived',
  'workspace.session.activity',
  'runtime.child.settled',
  'runtime.wait.satisfied',
] as const

export function createWorkspaceThread(): ThreadDefinition<WorkspaceState> {
  return workspaceModule.thread<WorkspaceState>({
    kind: 'shuttle-workspace',
    initialState: (ctx) => {
      const input = jsonObject(ctx.input)
      return {
        title: asString(input.title) ?? 'Shuttle workspace',
        folderOrder: [],
        folders: {},
        sessions: {},
        installations: {},
        mailboxEpoch: 0,
      }
    },
    step(state, event) {
      if (!isEventOf(event, STEPPED_EVENTS)) {
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
                autoReview: 'off',
              },
            },
            mailboxEpoch: state.mailboxEpoch + 1,
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
            mailboxEpoch: state.mailboxEpoch + 1,
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
            mailboxEpoch: state.mailboxEpoch + 1,
          }
        }

        case 'workspace.folder.reordered': {
          const known = new Set(state.folderOrder)
          const next = event.payload.folderIds.filter((id) => known.has(id))
          const missing = state.folderOrder.filter((id) => !next.includes(id))

          return {
            ...state,
            folderOrder: [...next, ...missing],
            mailboxEpoch: state.mailboxEpoch + 1,
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
            mailboxEpoch: state.mailboxEpoch + 1,
          }
        }

        case 'workspace.github.disconnected': {
          const next = { ...state.installations }
          delete next[String(event.payload.installationId)]
          return {
            ...state,
            installations: next,
            mailboxEpoch: state.mailboxEpoch + 1,
          }
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
            mailboxEpoch: state.mailboxEpoch + 1,
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
            mailboxEpoch: state.mailboxEpoch + 1,
          }
        }

        case 'workspace.session.requested': {
          // A workspace only ever launches sessions inside its own organization.
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
                attachments: event.payload.attachments,
                goal: event.payload.goal,
                title: event.payload.goal,
                status: 'requested',
                activity: 'idle',
                createdAt: at,
                updatedAt: at,
                archived: false,
                launched: false,
                lessons: event.payload.lessons.map((lesson) => ({
                  id: lesson.id,
                  text: lesson.text,
                  scope: lesson.scope,
                })),
                playbookVersion: event.payload.playbookVersion,
                playbookRunId: event.payload.playbookRunId,
                definitionName: event.payload.definitionName ?? 'coding',
                pull: event.payload.pull ?? null,
                hostMetadata: event.payload.hostMetadata,
                ownerId: event.payload.ownerId ?? null,
                memberIds: [],
                repos: event.payload.repos,
              },
            },
            mailboxEpoch: state.mailboxEpoch + 1,
          }
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
            mailboxEpoch: state.mailboxEpoch + 1,
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
                launched: true,
                status: 'running',
                activity: 'working',
                updatedAt: eventTimestamp(event),
              },
            },
            mailboxEpoch: state.mailboxEpoch + 1,
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
            mailboxEpoch: state.mailboxEpoch + 1,
          }
        }

        case 'workspace.session.listed': {
          const { payload } = event

          // The session is already running; it only needs to appear here.
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
                goal: payload.goal,
                title: payload.title,
                status: asSessionStatus(payload.status),
                activity: payload.activity,
                createdAt: payload.createdAt,
                updatedAt: payload.updatedAt,
                archived: payload.archived,
                launched: true,
                lessons: [],
                playbookVersion: 0,
                playbookRunId: null,
                definitionName: 'coding',
                pull: null,
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
            mailboxEpoch: state.mailboxEpoch + 1,
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
            return {
              ...state,
              mailboxEpoch: state.mailboxEpoch + 1,
            }
          }

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
              },
            },
            mailboxEpoch: state.mailboxEpoch + 1,
          }
        }

        case 'runtime.child.settled': {
          const payload = jsonObject(event.payload)
          const runId = asString(payload.runId)
          const status = asString(payload.status)

          if (runId === null || runId === '') {
            return state
          }

          const session = state.sessions[runId]

          if (!session) {
            return state
          }

          const nextStatus =
            status === 'completed' || status === 'failed' || status === 'cancelled'
              ? status
              : session.status

          return {
            ...state,
            sessions: {
              ...state.sessions,
              [runId]: {
                ...session,
                status: nextStatus,
                activity: 'idle',
                updatedAt: eventTimestamp(event),
              },
            },
            mailboxEpoch: state.mailboxEpoch + 1,
          }
        }

        case 'runtime.wait.satisfied': {
          return { ...state, mailboxEpoch: state.mailboxEpoch + 1 }
        }
      }
    },
    effects(state, ctx) {
      const effects: RuntimeEffect[] = []

      for (const session of Object.values(state.sessions)) {
        if (session.launched || session.archived) {
          continue
        }

        const folder = state.folders[session.folderId]
        const repos = session.repos ?? folder?.repos ?? []

        effects.push(
          launch({
            runId: session.runId,
            kind: 'shuttle-session',
            definitionName: session.definitionName,
            input: cleanUndefined({
              goal: session.goal,
              attachments:
                session.attachments !== undefined && session.attachments.length > 0
                  ? session.attachments
                  : undefined,
              folderId: session.folderId === NO_FOLDER ? undefined : session.folderId,
              workspaceRunId: ctx.runId,
              hostMetadata: session.hostMetadata,
              ownerId:
                session.ownerId === null || session.ownerId === '' ? undefined : session.ownerId,
              sandboxName: sandboxNameOfSession(session),
              repos: repos.map((repo) => ({
                installationId: repo.installationId,
                owner: repo.owner,
                name: repo.name,
                fullName: repo.fullName,
                defaultBranch: repo.defaultBranch,
                private: repo.private,
              })),
              playbookRunId: session.playbookRunId,
              playbookVersion: session.playbookVersion,
              lessons: session.lessons.map((lesson) => ({
                id: lesson.id,
                text: lesson.text,
                scope: lesson.scope === '' ? undefined : lesson.scope,
              })),
              pull: session.pull
                ? {
                    fullName: session.pull.fullName,
                    number: session.pull.number,
                    headSha: session.pull.headSha,
                    baseSha: session.pull.baseSha,
                  }
                : undefined,
            }),
            close: 'wait',
            tag: `launch_${session.runId}`,
          }),
          emit(
            workspaceModule.input('session.launched', { runId: session.runId }),
            `launched_${session.runId}`,
          ),
        )
      }

      effects.push(
        wait({
          waitId: createWaitId(ctx.threadId, `workspace_mailbox_${state.mailboxEpoch}`),
          on: {
            type: [
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
              'workspace.session.launched',
              'workspace.session.renamed',
              'workspace.session.archived',
              'workspace.session.activity',
              'runtime.child.settled',
            ],
          },
          tag: { kind: 'workspace-mailbox' },
        }),
      )

      return effects
    },
  })
}

export { sandboxNameFor }

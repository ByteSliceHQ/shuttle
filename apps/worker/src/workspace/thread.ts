import { Predicate } from 'effect'

import {
  createWaitId,
  emit,
  launch,
  wait,
  type JsonValue,
  type RuntimeEffect,
  type ThreadDefinition,
} from '@swirls/looms/core'

import type { LinkedRepo, SessionActivity } from './scope'
import { workspaceModule } from './scope'

export interface WorkspaceFolder {
  readonly folderId: string
  readonly name: string
  readonly createdAt: number
  readonly archived: boolean
  readonly repos: readonly LinkedRepo[]
}

export interface WorkspaceSession {
  readonly runId: string
  readonly folderId: string
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

function asObject(value: unknown): { [key: string]: JsonValue } {
  return Predicate.isObject(value) ? (value as { [key: string]: JsonValue }) : {}
}

function asString(value: unknown): string | null {
  return Predicate.isString(value) ? value : null
}

function asNumber(value: unknown): number | null {
  return Predicate.isNumber(value) ? value : null
}

function sandboxNameFor(folderId: string): string {
  return `folder:${folderId}`
}

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

export function createWorkspaceThread(): ThreadDefinition<WorkspaceState> {
  return workspaceModule.thread<WorkspaceState>({
    kind: 'shuttle-workspace',
    initialState: (ctx) => {
      const input = Predicate.isObject(ctx.input) ? ctx.input : {}
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
          if (state.sessions[event.payload.runId]) {
            return state
          }

          const now = Date.now()

          return {
            ...state,
            sessions: {
              ...state.sessions,
              [event.payload.runId]: {
                runId: event.payload.runId,
                folderId: event.payload.folderId,
                goal: event.payload.goal,
                title: event.payload.goal,
                status: 'requested',
                activity: 'idle',
                createdAt: now,
                updatedAt: now,
                archived: false,
                launched: false,
                lessons: event.payload.lessons.map((lesson) => ({
                  id: lesson.id,
                  text: lesson.text,
                  scope: lesson.scope,
                })),
                playbookVersion: event.payload.playbookVersion,
                playbookRunId: event.payload.playbookRunId,
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
                updatedAt: Date.now(),
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
                updatedAt: Date.now(),
              },
            },
            mailboxEpoch: state.mailboxEpoch + 1,
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
              [event.payload.runId]: { ...session, archived: true, updatedAt: Date.now() },
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

          if (isStaleActivityEvent(session, seq, event.payload.at)) {
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
                activityAt: Math.max(session.activityAt ?? 0, event.payload.at),
                ...(seq !== undefined
                  ? { activitySeq: Math.max(session.activitySeq ?? 0, seq) }
                  : {}),
                updatedAt: Math.max(session.updatedAt, event.payload.at),
              },
            },
            mailboxEpoch: state.mailboxEpoch + 1,
          }
        }

        case 'runtime.child.settled': {
          const payload = asObject(event.payload)
          const runId = asString(payload.runId)
          const status = asString(payload.status)

          if (!runId) {
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
                updatedAt: Date.now(),
              },
            },
            mailboxEpoch: state.mailboxEpoch + 1,
          }
        }

        case 'runtime.wait.satisfied': {
          return { ...state, mailboxEpoch: state.mailboxEpoch + 1 }
        }

        default:
          return state
      }
    },
    effects(state, ctx) {
      const effects: RuntimeEffect[] = []

      for (const session of Object.values(state.sessions)) {
        if (session.launched || session.archived) {
          continue
        }

        const folder = state.folders[session.folderId]
        const repos = folder?.repos ?? []

        effects.push(
          launch({
            runId: session.runId,
            kind: 'shuttle-session',
            definitionName: 'coding',
            input: {
              goal: session.goal,
              folderId: session.folderId,
              workspaceRunId: ctx.runId,
              sandboxName: sandboxNameFor(session.folderId),
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
              lessons: session.lessons,
            },
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

export { asNumber, sandboxNameFor }

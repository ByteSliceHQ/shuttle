import { Schema } from 'effect'

import { workspaceModule } from './scope'

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
})

const SessionSchema = Schema.Struct({
  runId: Schema.String,
  folderId: Schema.String,
  title: Schema.String,
  goal: Schema.String,
  status: Schema.String,
  activity: Schema.String,
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
  archived: Schema.Boolean,
})

const InstallationSchema = Schema.Struct({
  installationId: Schema.Finite,
  account: GithubAccountSchema,
})

export const workspaceTree = workspaceModule.projection({
  name: 'workspaceTree',
  shape: Schema.Struct({
    folderOrder: Schema.Array(Schema.String),
    folders: Schema.Record(Schema.String, FolderSchema),
    sessions: Schema.Record(Schema.String, SessionSchema),
    installations: Schema.Record(Schema.String, InstallationSchema),
  }),
  initialState: {
    folderOrder: [] as string[],
    folders: {} as Record<
      string,
      {
        folderId: string
        name: string
        createdAt: number
        archived: boolean
        repos: {
          installationId: number
          owner: string
          name: string
          fullName: string
          defaultBranch: string
          private: boolean
        }[]
      }
    >,
    sessions: {} as Record<
      string,
      {
        runId: string
        folderId: string
        title: string
        goal: string
        status: string
        activity: string
        createdAt: number
        updatedAt: number
        archived: boolean
      }
    >,
    installations: {} as Record<
      string,
      {
        installationId: number
        account: { login: string; type: string; avatarUrl: string }
      }
    >,
  },
  reduce(state, event) {
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
              title: event.payload.goal,
              goal: event.payload.goal,
              status: 'requested',
              activity: 'idle',
              createdAt: now,
              updatedAt: now,
              archived: false,
            },
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
              updatedAt: Date.now(),
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
              updatedAt: Date.now(),
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
              updatedAt: Date.now(),
            },
          },
        }
      }

      case 'workspace.session.activity': {
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
              activity: event.payload.activity,
              updatedAt: event.payload.at,
            },
          },
        }
      }

      case 'runtime.child.settled': {
        const payload = event.payload as {
          runId?: string
          status?: string
        }

        const runId = typeof payload.runId === 'string' ? payload.runId : null
        const status = typeof payload.status === 'string' ? payload.status : null

        if (!runId) {
          return state
        }

        const session = state.sessions[runId]

        if (!session) {
          return state
        }

        return {
          ...state,
          sessions: {
            ...state.sessions,
            [runId]: {
              ...session,
              status: status ?? session.status,
              activity: 'idle',
              updatedAt: Date.now(),
            },
          },
        }
      }

      default:
        return state
    }
  },
})

import { Schema } from 'effect'

import { AttachmentRefSchema } from '../session/scope'
import { SessionActivitySchema, TabKindSchema, workspaceModule } from './scope'

const LinkedRepoSchema = Schema.Struct({
  installationId: Schema.Finite,
  owner: Schema.String,
  name: Schema.String,
  fullName: Schema.String,
  defaultBranch: Schema.String,
  private: Schema.Boolean,
})

const LessonSchema = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  scope: Schema.optional(Schema.String),
})

const GithubAccountSchema = Schema.Struct({
  login: Schema.String,
  type: Schema.String,
  avatarUrl: Schema.String,
})

/** Matches the sidebar's inline input `maxLength`. */
const DisplayNameSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))

export const createFolder = workspaceModule.signal({
  description: 'Create a workspace folder.',
  input: Schema.Struct({
    folderId: Schema.String,
    name: DisplayNameSchema,
    createdAt: Schema.Finite,
  }),
  build: (input) =>
    workspaceModule.input('folder.created', input, {
      idempotencyKey: `workspace-folder:${input.folderId}`,
    }),
})

export const renameFolder = workspaceModule.signal({
  description: 'Rename a workspace folder.',
  input: Schema.Struct({
    folderId: Schema.String,
    name: DisplayNameSchema,
  }),
  build: (input) => workspaceModule.input('folder.renamed', input),
})

export const archiveFolder = workspaceModule.signal({
  description: 'Archive a workspace folder.',
  input: Schema.Struct({
    folderId: Schema.String,
  }),
  build: (input) => workspaceModule.input('folder.archived', input),
})

export const reorderFolders = workspaceModule.signal({
  description: 'Reorder workspace folders.',
  input: Schema.Struct({
    folderIds: Schema.Array(Schema.String),
  }),
  build: (input) => workspaceModule.input('folder.reordered', input),
})

export const connectGithub = workspaceModule.signal({
  description: 'Record a connected GitHub App installation.',
  input: Schema.Struct({
    installationId: Schema.Finite,
    account: GithubAccountSchema,
  }),
  build: (input) =>
    workspaceModule.input('github.connected', input, {
      idempotencyKey: `workspace-github:${input.installationId}`,
    }),
})

export const disconnectGithub = workspaceModule.signal({
  description: 'Disconnect a GitHub App installation.',
  input: Schema.Struct({
    installationId: Schema.Finite,
  }),
  build: (input) => workspaceModule.input('github.disconnected', input),
})

export const linkRepo = workspaceModule.signal({
  description: 'Link a GitHub repository to a folder.',
  input: Schema.Struct({
    folderId: Schema.String,
    repo: LinkedRepoSchema,
  }),
  build: (input) =>
    workspaceModule.input('repo.linked', input, {
      idempotencyKey: `workspace-repo:${input.folderId}:${input.repo.fullName}`,
    }),
})

export const unlinkRepo = workspaceModule.signal({
  description: 'Unlink a GitHub repository from a folder.',
  input: Schema.Struct({
    folderId: Schema.String,
    fullName: Schema.String,
  }),
  build: (input) => workspaceModule.input('repo.unlinked', input),
})

export const requestSession = workspaceModule.signal({
  description: 'Request a coding or review session launch inside a folder.',
  input: Schema.Struct({
    runId: Schema.String,
    folderId: Schema.String,
    goal: Schema.String,
    attachments: Schema.optional(Schema.Array(AttachmentRefSchema)),
    lessons: Schema.Array(LessonSchema),
    playbookVersion: Schema.Finite,
    playbookRunId: Schema.NullOr(Schema.String),
    definitionName: Schema.optional(Schema.String),
    ownerId: Schema.optional(Schema.String),
    repos: Schema.optional(Schema.Array(LinkedRepoSchema)),
    pull: Schema.optional(
      Schema.Struct({
        fullName: Schema.String,
        number: Schema.Finite,
        headSha: Schema.String,
        baseSha: Schema.String,
      }),
    ),
    hostMetadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
  build: (input) =>
    workspaceModule.input('session.requested', input, {
      idempotencyKey: `workspace-session:${input.runId}`,
    }),
})

export const setFolderAutoReview = workspaceModule.signal({
  description: 'Set automatic pull-request review mode for a folder.',
  input: Schema.Struct({
    folderId: Schema.String,
    autoReview: Schema.Union([
      Schema.Literal('off'),
      Schema.Literal('others'),
      Schema.Literal('all'),
    ]),
  }),
  build: (input) => workspaceModule.input('folder.auto_review.set', input),
})

export const renameSession = workspaceModule.signal({
  description: 'Rename a coding session in the sidebar.',
  input: Schema.Struct({
    runId: Schema.String,
    title: DisplayNameSchema,
  }),
  build: (input) => workspaceModule.input('session.renamed', input),
})

export const shareSession = workspaceModule.signal({
  description: 'Record who else may open a session. Sent by the Worker after it checks them.',
  input: Schema.Struct({
    runId: Schema.String,
    memberIds: Schema.Array(Schema.String),
  }),
  build: (input) => workspaceModule.input('session.shared', input),
})

export const listSession = workspaceModule.signal({
  description: 'Start listing an existing session in this workspace. Sent by the Worker.',
  input: Schema.Struct({
    runId: Schema.String,
    folderId: Schema.String,
    goal: Schema.String,
    title: Schema.String,
    status: Schema.String,
    activity: SessionActivitySchema,
    createdAt: Schema.Finite,
    updatedAt: Schema.Finite,
    archived: Schema.Boolean,
    ownerId: Schema.NullOr(Schema.String),
    memberIds: Schema.Array(Schema.String),
  }),
  build: (input) => workspaceModule.input('session.listed', input),
})

export const unlistSession = workspaceModule.signal({
  description: 'Stop listing a session in this workspace. Sent by the Worker.',
  input: Schema.Struct({
    runId: Schema.String,
  }),
  build: (input) => workspaceModule.input('session.unlisted', input),
})

export const archiveSession = workspaceModule.signal({
  description: 'Archive a coding session in the sidebar.',
  input: Schema.Struct({
    runId: Schema.String,
  }),
  build: (input) => workspaceModule.input('session.archived', input),
})

export const reportActivity = workspaceModule.signal({
  description: 'Report live activity for a coding session.',
  input: Schema.Struct({
    runId: Schema.String,
    activity: SessionActivitySchema,
    at: Schema.Finite,
    seq: Schema.optional(Schema.Finite),
  }),
  build: (input) => workspaceModule.input('session.activity', input),
})

export const openTab = workspaceModule.signal({
  description: 'Open an artifact tab for a coding session.',
  input: Schema.Struct({
    runId: Schema.String,
    tabId: Schema.String,
    kind: TabKindSchema,
    title: Schema.String,
    target: Schema.String,
    at: Schema.Finite,
  }),
  build: (input) =>
    workspaceModule.input('tab.opened', input, {
      idempotencyKey: `workspace-tab:${input.runId}:${input.tabId}`,
    }),
})

export const closeTab = workspaceModule.signal({
  description: 'Close an artifact tab for a coding session.',
  input: Schema.Struct({
    runId: Schema.String,
    tabId: Schema.String,
  }),
  build: (input) => workspaceModule.input('tab.closed', input),
})

export const reorderTabs = workspaceModule.signal({
  description: 'Reorder artifact tabs for a coding session.',
  input: Schema.Struct({
    runId: Schema.String,
    tabIds: Schema.Array(Schema.String),
  }),
  build: (input) => workspaceModule.input('tab.reordered', input),
})

export const retargetTab = workspaceModule.signal({
  description: 'Update an artifact tab title or target.',
  input: Schema.Struct({
    runId: Schema.String,
    tabId: Schema.String,
    title: Schema.String,
    target: Schema.String,
  }),
  build: (input) => workspaceModule.input('tab.retargeted', input),
})

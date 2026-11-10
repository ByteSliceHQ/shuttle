import { Schema } from 'effect'

import { agentCatalog } from '@swirls/looms/agent'
import { approvalCatalog } from '@swirls/looms/approval'
import { createModuleScope, defineEventCatalog } from '@swirls/looms/core'

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

const LessonSchema = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  scope: Schema.optional(Schema.String),
})

const SessionActivitySchema = Schema.Union([
  Schema.Literal('working'),
  Schema.Literal('needs_input'),
  Schema.Literal('idle'),
])

export const workspaceCatalog = defineEventCatalog('workspace', {
  'folder.created': Schema.Struct({
    folderId: Schema.String,
    name: Schema.String,
    createdAt: Schema.Finite,
  }),
  'folder.renamed': Schema.Struct({
    folderId: Schema.String,
    name: Schema.String,
  }),
  'folder.archived': Schema.Struct({
    folderId: Schema.String,
  }),
  'folder.reordered': Schema.Struct({
    folderIds: Schema.Array(Schema.String),
  }),
  'github.connected': Schema.Struct({
    installationId: Schema.Finite,
    account: GithubAccountSchema,
  }),
  'github.disconnected': Schema.Struct({
    installationId: Schema.Finite,
  }),
  'repo.linked': Schema.Struct({
    folderId: Schema.String,
    repo: LinkedRepoSchema,
  }),
  'repo.unlinked': Schema.Struct({
    folderId: Schema.String,
    fullName: Schema.String,
  }),
  'session.requested': Schema.Struct({
    runId: Schema.String,
    folderId: Schema.String,
    goal: Schema.String,
    lessons: Schema.Array(LessonSchema),
    playbookVersion: Schema.Finite,
    playbookRunId: Schema.NullOr(Schema.String),
  }),
  'session.launched': Schema.Struct({
    runId: Schema.String,
  }),
  'session.renamed': Schema.Struct({
    runId: Schema.String,
    title: Schema.String,
  }),
  'session.archived': Schema.Struct({
    runId: Schema.String,
  }),
  'session.activity': Schema.Struct({
    runId: Schema.String,
    activity: SessionActivitySchema,
    at: Schema.Finite,
  }),
})

export const workspaceModule = createModuleScope({
  namespace: 'workspace',
  protocolVersion: '1.0.0',
  description: 'Folders, GitHub installs, linked repos, and session launches.',
  events: workspaceCatalog,
  observes: [agentCatalog, approvalCatalog],
})

export type LinkedRepo = {
  readonly installationId: number
  readonly owner: string
  readonly name: string
  readonly fullName: string
  readonly defaultBranch: string
  readonly private: boolean
}

export type SessionActivity = 'working' | 'needs_input' | 'idle'

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

/** A file attached to a session's first message. The bytes are in the session's media store. */
const AttachmentRefSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mediaType: Schema.String,
  size: Schema.Finite,
})

const LessonSchema = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  scope: Schema.optional(Schema.String),
})

export const SessionActivitySchema = Schema.Union([
  Schema.Literal('working'),
  Schema.Literal('needs_input'),
  Schema.Literal('idle'),
  Schema.Literal('error'),
])

export const TabKindSchema = Schema.Union([
  Schema.Literal('events'),
  Schema.Literal('files'),
  Schema.Literal('file'),
  Schema.Literal('changes'),
  Schema.Literal('terminal'),
  Schema.Literal('browser'),
  Schema.Literal('review'),
  Schema.Literal('media'),
  // A kind the host draws itself, named `<namespace>:<name>`. See `CustomArtifactTabKind` in
  // `@shuttle/api`, which this matches. The run keeps the tab and never looks inside it.
  Schema.TemplateLiteral([Schema.String, ':', Schema.String]).check(
    Schema.isPattern(/^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/),
    Schema.isMaxLength(64),
  ),
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
  'folder.auto_review.set': Schema.Struct({
    folderId: Schema.String,
    autoReview: Schema.Union([
      Schema.Literal('off'),
      Schema.Literal('others'),
      Schema.Literal('all'),
    ]),
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
    attachments: Schema.optional(Schema.Array(AttachmentRefSchema)),
    lessons: Schema.Array(LessonSchema),
    playbookVersion: Schema.Finite,
    playbookRunId: Schema.NullOr(Schema.String),
    definitionName: Schema.optional(Schema.String),
    /** The person who started the session. Absent when Shuttle started it. */
    ownerId: Schema.optional(Schema.String),
    /**
     * The repositories the session works on, read from its folder when it was requested. A
     * personal workspace has no folders of its own to read them from.
     */
    repos: Schema.optional(Schema.Array(LinkedRepoSchema)),
    pull: Schema.optional(
      Schema.Struct({
        fullName: Schema.String,
        number: Schema.Finite,
        headSha: Schema.String,
        baseSha: Schema.String,
      }),
    ),
  }),
  /**
   * A session that already exists starts being listed in this workspace: it was shared with this
   * person, or made public. Carries the session as its previous listing showed it.
   */
  'session.listed': Schema.Struct({
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
  /** This workspace stops listing a session: it was unshared, or its visibility changed. */
  'session.unlisted': Schema.Struct({
    runId: Schema.String,
  }),
  /** The owner changed who else may open the session. `memberIds` is the whole new list. */
  'session.shared': Schema.Struct({
    runId: Schema.String,
    memberIds: Schema.Array(Schema.String),
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
    seq: Schema.optional(Schema.Finite),
  }),
  'tab.opened': Schema.Struct({
    runId: Schema.String,
    tabId: Schema.String,
    kind: TabKindSchema,
    title: Schema.String,
    target: Schema.String,
    at: Schema.Finite,
  }),
  'tab.closed': Schema.Struct({
    runId: Schema.String,
    tabId: Schema.String,
  }),
  'tab.reordered': Schema.Struct({
    runId: Schema.String,
    tabIds: Schema.Array(Schema.String),
  }),
  'tab.retargeted': Schema.Struct({
    runId: Schema.String,
    tabId: Schema.String,
    title: Schema.String,
    target: Schema.String,
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

export type SessionActivity = 'working' | 'needs_input' | 'idle' | 'error'

export type ArtifactTabKind =
  | 'events'
  | 'files'
  | 'file'
  | 'changes'
  | 'terminal'
  | 'browser'
  | 'review'
  | 'media'
  | `${string}:${string}`

export type ArtifactTab = {
  readonly tabId: string
  readonly kind: ArtifactTabKind
  readonly title: string
  readonly target: string
  readonly openedAt: number
}

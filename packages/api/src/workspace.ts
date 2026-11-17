import { oc } from '@orpc/contract'
import { z } from 'zod'

import { Ok } from './common'

/** A GitHub repository a folder works on, reached through one installation of the App. */
export const LinkedRepo = z.object({
  installationId: z.number(),
  owner: z.string(),
  name: z.string(),
  fullName: z.string(),
  defaultBranch: z.string(),
  private: z.boolean(),
})
export type LinkedRepo = z.infer<typeof LinkedRepo>

/** Which pull requests in a folder's repositories Shuttle reviews without being asked. */
export const AutoReviewMode = z.enum(['off', 'others', 'all'])
export type AutoReviewMode = z.infer<typeof AutoReviewMode>

export const WorkspaceFolder = z.object({
  folderId: z.string(),
  name: z.string(),
  createdAt: z.number(),
  archived: z.boolean(),
  // A folder made before repos could be linked has none stored.
  repos: z.array(LinkedRepo).readonly().default([]),
  /** Absent on a folder made before automatic review existed, which means `off`. */
  autoReview: AutoReviewMode.optional(),
})
export type WorkspaceFolder = z.infer<typeof WorkspaceFolder>

/** What a session is doing, as its listing in a workspace shows it. */
export const SessionActivity = z.enum(['working', 'needs_input', 'idle', 'error'])
export type SessionActivity = z.infer<typeof SessionActivity>

/** A session as a workspace lists it. */
export const WorkspaceSession = z.object({
  runId: z.string(),
  folderId: z.string(),
  title: z.string(),
  goal: z.string(),
  /**
   * `requested`, `running`, `completed`, `failed` or `cancelled`. Left open because it is copied
   * from the session's run, which may settle in a state this list does not name.
   */
  status: z.string(),
  /** A `SessionActivity`. The workspace stores it as text, so it is read back as text. */
  activity: z.string(),
  /** The session's log position the activity was read at, so an older report cannot replace it. */
  activitySeq: z.number().optional(),
  activityAt: z.number().optional(),
  lastCompletedAt: z.number().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  archived: z.boolean(),
  /** The person who started the session. Null or absent when Shuttle started it. */
  ownerId: z.string().nullish(),
  /** People the owner shared the session with. */
  memberIds: z.array(z.string()).readonly().optional(),
})
export type WorkspaceSession = z.infer<typeof WorkspaceSession>

export const GithubInstallation = z.object({
  installationId: z.number(),
  account: z.object({
    login: z.string(),
    type: z.string(),
    avatarUrl: z.string(),
  }),
})
export type GithubInstallation = z.infer<typeof GithubInstallation>

/** A workspace's folders, the sessions listed in it, and the GitHub installations it can use. */
export const WorkspaceTree = z.object({
  folderOrder: z.array(z.string()).readonly(),
  folders: z.record(z.string(), WorkspaceFolder).readonly(),
  sessions: z.record(z.string(), WorkspaceSession).readonly(),
  installations: z.record(z.string(), GithubInstallation).readonly(),
})
export type WorkspaceTree = z.infer<typeof WorkspaceTree>

/** The kinds of tab Shuttle itself draws. */
export const ARTIFACT_TAB_KINDS = [
  'events',
  'files',
  'file',
  'changes',
  'terminal',
  'browser',
  'review',
  'media',
] as const

export const BuiltinArtifactTabKind = z.enum(ARTIFACT_TAB_KINDS)
export type BuiltinArtifactTabKind = z.infer<typeof BuiltinArtifactTabKind>

/**
 * A kind of tab that whoever put Shuttle's components together draws themself, named
 * `<namespace>:<name>` in lower case, as in `acme:designs`. The namespace keeps it apart from
 * Shuttle's own kinds, present and future. The backend keeps such a tab without knowing what
 * it shows; its `target` is the type's to give meaning to.
 */
export const CustomArtifactTabKind = z
  .templateLiteral([
    z.string().regex(/^[a-z][a-z0-9-]*$/),
    ':',
    z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  ])
  .refine((kind) => kind.length <= 64, 'A tab kind is at most 64 characters.')
export type CustomArtifactTabKind = z.infer<typeof CustomArtifactTabKind>

export const ArtifactTabKind = z.union([BuiltinArtifactTabKind, CustomArtifactTabKind])
export type ArtifactTabKind = z.infer<typeof ArtifactTabKind>

export function isCustomArtifactTabKind(kind: string): kind is CustomArtifactTabKind {
  return CustomArtifactTabKind.safeParse(kind).success
}

/** One tab open beside a session. */
export const ArtifactTab = z.object({
  tabId: z.string(),
  kind: ArtifactTabKind,
  title: z.string(),
  target: z.string(),
  openedAt: z.number(),
})
export type ArtifactTab = z.infer<typeof ArtifactTab>

export const SessionTabSet = z.object({
  order: z.array(z.string()).readonly(),
  tabs: z.record(z.string(), ArtifactTab).readonly(),
})
export type SessionTabSet = z.infer<typeof SessionTabSet>

/** The tabs open beside each session, by the session's run id. */
export const SessionTabsState = z.record(z.string(), SessionTabSet).readonly()
export type SessionTabsState = z.infer<typeof SessionTabsState>

/**
 * One workspace as it stands: its tree and tabs, and the log position (`tail`) they were read at,
 * so a client can follow the workspace's events from there. `tree` and `tabs` are null when the
 * workspace could not be read.
 */
export const WorkspaceSnapshot = z.object({
  runId: z.string(),
  tail: z.number(),
  tree: WorkspaceTree.nullable(),
  tabs: SessionTabsState.nullable(),
})
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshot>

/** The organization's workspace, and inside it the caller's own. */
export const WorkspaceSnapshotResponse = WorkspaceSnapshot.extend({ personal: WorkspaceSnapshot })
export type WorkspaceSnapshotResponse = z.infer<typeof WorkspaceSnapshotResponse>

export const RepoSyncStatus = z.enum(['ok', 'forbidden', 'failed'])
export type RepoSyncStatus = z.infer<typeof RepoSyncStatus>

export const RepoSyncReport = z.object({
  fullName: z.string(),
  status: RepoSyncStatus,
  /** Open PRs GitHub reports for the repo. */
  open: z.number(),
  /** Open PRs Shuttle ingested (capped per repo). */
  synced: z.number(),
  checksHidden: z.boolean(),
  message: z.string().nullable(),
})
export type RepoSyncReport = z.infer<typeof RepoSyncReport>

export const InstallationAccessReport = z.object({
  installationId: z.number(),
  account: z.string(),
  missingPermissions: z.array(z.string()).readonly(),
  settingsUrl: z.string(),
})
export type InstallationAccessReport = z.infer<typeof InstallationAccessReport>

export const FolderSyncReport = z.object({
  folderId: z.string(),
  upserted: z.number(),
  repos: z.array(RepoSyncReport).readonly(),
  installations: z.array(InstallationAccessReport).readonly(),
})
export type FolderSyncReport = z.infer<typeof FolderSyncReport>

/** The folder a `/workspace/folders/{folderId}/…` path names. */
const FolderParams = z.object({ folderId: z.string().min(1) })

/** The pull request a `/workspace/folders/{folderId}/pulls/{fullName}/{number}/…` path names. */
const PullParams = FolderParams.extend({
  /** `owner/name`, sent as one path segment with its slash encoded. */
  fullName: z.string().min(1),
  number: z.coerce.number<number | string>().int().nonnegative(),
})

const DiffSide = z.enum(['LEFT', 'RIGHT'])

export const workspaceContract = {
  /**
   * The two workspaces a person sees: the organization's, with its folders and public sessions,
   * and their own, with the sessions that are private to them or shared with them.
   */
  get: oc.route({ method: 'GET', path: '/workspace' }).output(WorkspaceSnapshotResponse),

  /** Starts a session in a folder. It is private to the caller until they share it. */
  createSession: oc
    .route({ method: 'POST', path: '/workspace/sessions' })
    .input(
      z.object({
        folderId: z.string().min(1),
        goal: z.string().trim().min(1),
        /** One of the caller's own machines to start on, as the desktop app asks for. */
        deviceId: z.string().nullish(),
      }),
    )
    .output(z.object({ runId: z.string() })),

  repos: {
    /** Links a repository to a folder. Only an installation the organization connected may be used. */
    link: oc
      .route({ method: 'POST', path: '/workspace/folders/{folderId}/repos' })
      .input(
        FolderParams.extend({
          installationId: z.coerce.number<number | string>(),
          owner: z.string().min(1),
          name: z.string().min(1),
        }),
      )
      .output(z.object({ folderId: z.string(), repo: LinkedRepo })),

    unlink: oc
      .route({ method: 'DELETE', path: '/workspace/folders/{folderId}/repos' })
      .input(FolderParams.extend({ fullName: z.string().min(1) }))
      .output(z.object({ folderId: z.string(), fullName: z.string(), unlinked: z.literal(true) })),
  },

  pulls: {
    /** Fetches every open pull request on the folder's repositories into the inbox. */
    sync: oc
      .route({ method: 'POST', path: '/workspace/folders/{folderId}/pulls/sync' })
      .input(FolderParams)
      .output(FolderSyncReport),

    /** Fetches a pull request's review threads from GitHub into the mirror people read. */
    syncThreads: oc
      .route({
        method: 'POST',
        path: '/workspace/folders/{folderId}/pulls/{fullName}/{number}/threads/sync',
      })
      .input(PullParams)
      .output(z.object({ threads: z.number(), changed: z.boolean() })),

    /**
     * Posts a comment on a pull request as the signed-in person: a reply when `rootId` names a
     * thread, otherwise a new thread on `path` and `line`.
     */
    comment: oc
      .route({
        method: 'POST',
        path: '/workspace/folders/{folderId}/pulls/{fullName}/{number}/comments',
      })
      .input(
        PullParams.extend({
          body: z.string().default(''),
          /** The first comment of the thread being replied to. */
          rootId: z.number().optional(),
          path: z.string().optional(),
          line: z.number().optional(),
          side: DiffSide.optional(),
          /** For a comment about several lines: where they start. `line` is where they end. */
          startLine: z.number().optional(),
          startSide: DiffSide.optional(),
        }),
      )
      .output(Ok.extend({ commentId: z.number() })),

    /** Resolves or reopens a thread on a pull request as the signed-in person. */
    resolveThread: oc
      .route({
        method: 'POST',
        path: '/workspace/folders/{folderId}/pulls/{fullName}/{number}/threads/{rootId}/resolution',
      })
      .input(
        PullParams.extend({
          rootId: z.coerce.number<number | string>().int().nonnegative(),
          resolved: z.boolean().default(false),
        }),
      )
      .output(Ok),

    /** Starts a private session that reviews a pull request at the commit given. */
    review: oc
      .route({
        method: 'POST',
        path: '/workspace/folders/{folderId}/pulls/{fullName}/{number}/review',
      })
      .input(
        PullParams.extend({
          /** The session checks this commit out to read; without it there is nothing to review. */
          headSha: z.string().min(1),
          baseSha: z.string().optional(),
          title: z.string().optional(),
        }),
      )
      .output(z.object({ runId: z.string() })),
  },
}

import { oc } from '@orpc/contract'
import { z } from 'zod'

import { SessionParams } from './common'

/**
 * Where a tab's contents came from: the running `sandbox`, the session's work as last `saved`
 * while its sandbox sleeps, or nowhere because the sandbox is `asleep` with nothing saved.
 */
export const SandboxSource = z.object({
  source: z.enum(['sandbox', 'saved', 'asleep']),
  /** When the saved copy was saved, in milliseconds. Absent when read from the sandbox. */
  savedAt: z.number().nullable().optional(),
})
export type SandboxSource = z.infer<typeof SandboxSource>

export const SandboxFileEntry = z.object({ path: z.string(), kind: z.enum(['file', 'dir']) })
export type SandboxFileEntry = z.infer<typeof SandboxFileEntry>

export const SandboxFiles = SandboxSource.extend({
  root: z.string(),
  files: z.array(SandboxFileEntry),
  mode: z.enum(['memory', 'container']),
})
export type SandboxFiles = z.infer<typeof SandboxFiles>

/**
 * One file in the session's worktree. Asked for as it was when the session started
 * (`version: 'base'`), `content` is null when it did not exist then, and nothing says whether it
 * is binary or was cut short.
 */
export const SandboxFile = SandboxSource.extend({
  path: z.string(),
  content: z.string().nullable(),
  binary: z.boolean().optional(),
  truncated: z.boolean().optional(),
})
export type SandboxFile = z.infer<typeof SandboxFile>

export const SandboxDiffEntry = z.object({ cwd: z.string(), name: z.string(), diff: z.string() })
export type SandboxDiffEntry = z.infer<typeof SandboxDiffEntry>

/** Every repository's changes since the session started. */
export const SandboxDiffs = SandboxSource.extend({ diffs: z.array(SandboxDiffEntry) })
export type SandboxDiffs = z.infer<typeof SandboxDiffs>

/** One file's changes since the session started. `path` is null when it named no file. */
export const SandboxFileDiff = SandboxSource.extend({
  path: z.string().nullable(),
  diff: z.string(),
})
export type SandboxFileDiff = z.infer<typeof SandboxFileDiff>

/** How a file differs from where the session started: added, modified or deleted. */
export const ChangeStatus = z.enum(['A', 'M', 'D'])
export type ChangeStatus = z.infer<typeof ChangeStatus>

/** One repository in a session's workspace. */
export const SandboxWorkspaceRepo = z.object({
  /** Its directory in the workspace. */
  name: z.string(),
  /** Its name on GitHub. Null for the scratch repository of a folder with none linked. */
  fullName: z.string().nullable(),
  /** The branch its changes are measured from. */
  defaultBranch: z.string(),
  /** Every file, relative to the repository. */
  files: z.array(z.string()).readonly(),
  changes: z.array(z.object({ path: z.string(), status: ChangeStatus })).readonly(),
})
export type SandboxWorkspaceRepo = z.infer<typeof SandboxWorkspaceRepo>

/** A session's workspace: its repositories, what changed in each, and where it was read from. */
export const SandboxWorkspace = SandboxSource.extend({
  /** Whether agents are working in the session right now. Only known while the sandbox is awake. */
  working: z.boolean().optional(),
  /** Whose sandbox holds the workspace, where each person has one. Null otherwise. */
  holderId: z.string().nullable(),
  repos: z.array(SandboxWorkspaceRepo).readonly(),
  /** Things written under /workspace but outside the session's workspace. */
  strays: z.array(z.object({ path: z.string(), files: z.number() })).readonly(),
})
export type SandboxWorkspace = z.infer<typeof SandboxWorkspace>

export const DiagnosticSeverity = z.enum(['error', 'warning', 'info', 'hint'])
export type DiagnosticSeverity = z.infer<typeof DiagnosticSeverity>

/** One problem the language server found. Positions are 1-based, as an editor shows them. */
export const FileDiagnostic = z.object({
  line: z.number(),
  column: z.number(),
  endLine: z.number(),
  /** The column after the problem's last character. */
  endColumn: z.number(),
  severity: DiagnosticSeverity,
  message: z.string(),
  code: z.string().optional(),
  source: z.string().optional(),
})
export type FileDiagnostic = z.infer<typeof FileDiagnostic>

export const FileDiagnostics = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    server: z.string(),
    diagnostics: z.array(FileDiagnostic).readonly(),
  }),
  /** The server is still starting. Asking again shortly will answer. */
  z.object({ status: z.literal('pending'), server: z.string().optional() }),
  /** No server covers this kind of file, or this sandbox cannot run one. */
  z.object({
    status: z.enum(['unsupported', 'unavailable', 'error']),
    reason: z.string().optional(),
  }),
])
export type FileDiagnostics = z.infer<typeof FileDiagnostics>

/** Largest text a draft may be to have the language server check it, in characters. */
export const MAX_DIAGNOSTICS_CHARS = 512_000

/** Largest file a person may save from the browser, in characters. */
export const MAX_WRITE_CHARS = 2_000_000

const Machine = {
  /** For a sandbox on someone's machine: whether that machine is connected. */
  online: z.boolean().optional(),
  device: z.object({ id: z.string(), name: z.string(), platform: z.string() }).optional(),
  backend: z.object({ id: z.string(), label: z.string(), isolation: z.string() }).optional(),
}

/** Whose sandbox holds a session's files, as it bears on a terminal the viewer opens. */
export const SandboxPlace = z.object({
  /** Where a move that is waiting for the session to stop working will take it. */
  pending: z.enum(['local', 'cloud']).nullable(),
  /** Set when the session last left a machine that was not connected, from its last save. */
  leftBehind: z.object({ deviceId: z.string().nullable(), at: z.number() }).nullable(),
  /** Whether each person has a sandbox of their own. */
  personal: z.boolean(),
  /** The person whose sandbox holds the session's files. Null when unknown or not personal. */
  holderId: z.string().nullable(),
  /** Whether the session's files are in the sandbox the viewer's terminal opens in. */
  here: z.boolean(),
  /** The sandbox that holds the session's files. */
  sandbox: z.object({
    provider: z.string(),
    location: z.enum(['local', 'cloud']),
    deviceId: z.string().nullable().optional(),
    ...Machine,
  }),
  /** Set while the session is placed on a person's own machine. */
  local: z.object({ deviceId: z.string(), mine: z.boolean() }).nullable(),
  cloud: z.object({ provider: z.string(), movable: z.boolean() }),
})
export type SandboxPlace = z.infer<typeof SandboxPlace>

/** Where a session's previews are served. */
export const PreviewAddress = z.object({
  /** The label that leads to the session's sandbox in a preview hostname. */
  label: z.string(),
  /** The domain previews hang off, when the deployment names one. */
  host: z.string().optional(),
})
export type PreviewAddress = z.infer<typeof PreviewAddress>

/** A file by its path: `<repository>/<path>`, or absolute inside the session's worktree. */
const FilePath = z.string().min(1)

export const sandboxContract = {
  /** Every file in the session's worktree. */
  files: oc
    .route({ method: 'GET', path: '/sessions/{id}/sandbox/files' })
    .input(SessionParams)
    .output(SandboxFiles),

  /** One file, as it is now or, with `version: 'base'`, as it was when the session started. */
  file: oc
    .route({ method: 'GET', path: '/sessions/{id}/sandbox/file' })
    .input(SessionParams.extend({ path: FilePath, version: z.enum(['base']).optional() }))
    .output(SandboxFile),

  /** One file's changes since the session started, given `path`; every repository's without. */
  diff: oc
    .route({ method: 'GET', path: '/sessions/{id}/sandbox/diff' })
    .input(SessionParams.extend({ path: FilePath.optional() }))
    .output(z.union([SandboxFileDiff, SandboxDiffs])),

  workspace: oc
    .route({ method: 'GET', path: '/sessions/{id}/sandbox/workspace' })
    .input(SessionParams)
    .output(SandboxWorkspace),

  /**
   * Saves a person's edit to one file in the session's workspace. `expected` is the text the
   * person started from: if the file has changed since, the edit is refused.
   */
  write: oc
    .route({ method: 'POST', path: '/sessions/{id}/sandbox/write' })
    .input(
      SessionParams.extend({
        path: FilePath,
        content: z.string().max(MAX_WRITE_CHARS),
        expected: z.string().optional(),
      }),
    )
    .output(z.object({ ok: z.literal(true), path: z.string() })),

  /** Moves something an agent wrote outside the worktree into the session's first repository. */
  adopt: oc
    .route({ method: 'POST', path: '/sessions/{id}/sandbox/adopt' })
    .input(SessionParams.extend({ path: z.string() }))
    .output(z.object({ ok: z.literal(true) })),

  diagnostics: {
    /** What the sandbox's language server says about a file as saved. */
    saved: oc
      .route({ method: 'GET', path: '/sessions/{id}/sandbox/diagnostics' })
      .input(SessionParams.extend({ path: FilePath }))
      .output(FileDiagnostics),

    /** The same, for text someone is typing and has not saved. The file is named in the query. */
    draft: oc
      .route({
        method: 'POST',
        path: '/sessions/{id}/sandbox/diagnostics',
        inputStructure: 'detailed',
      })
      .input(
        z.object({
          params: SessionParams,
          query: z.object({ path: FilePath }),
          body: z.object({ content: z.string().max(MAX_DIAGNOSTICS_CHARS) }),
        }),
      )
      .output(FileDiagnostics),
  },

  place: {
    get: oc
      .route({ method: 'GET', path: '/sessions/{id}/sandbox/place' })
      .input(SessionParams)
      .output(SandboxPlace),

    /**
     * Moves a session, with its work, to one of the caller's own machines or back to the cloud.
     * A session that is working moves once it stops: `pending` in the answer says where to.
     */
    move: oc
      .route({ method: 'POST', path: '/sessions/{id}/sandbox/place' })
      .input(
        z.discriminatedUnion('to', [
          SessionParams.extend({ to: z.literal('local'), deviceId: z.string().min(1) }),
          SessionParams.extend({ to: z.literal('cloud') }),
        ]),
      )
      .output(SandboxPlace),
  },

  /** Only people who can open the session can ask for its preview address. */
  preview: oc
    .route({ method: 'GET', path: '/sessions/{id}/sandbox/preview' })
    .input(SessionParams)
    .output(PreviewAddress),
}

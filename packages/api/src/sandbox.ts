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

/**
 * What a repository's changes are measured against. Left out, it is `session`.
 *
 * - `session`: where the session started, so every change it made, committed or not.
 * - `uncommitted`: the last commit, so only work not committed yet.
 * - `ref:<ref>`: a branch or commit, from where the work and it split. The working tree is the
 *   other side, so work not committed yet is counted.
 * - `range:<base>...<head>`: what `<head>` changes since it split from `<base>`, as a pull request
 *   shows it. Commits only: the working tree is not read.
 */
export const Comparison = z
  .string()
  .max(400)
  .refine((value) => parseComparison(value) !== null, {
    message: 'Not a comparison: session, uncommitted, ref:<ref> or range:<base>...<head>',
  })
export type Comparison = z.infer<typeof Comparison>

/** A comparison taken apart. */
export type ParsedComparison =
  | { readonly kind: 'session' }
  | { readonly kind: 'uncommitted' }
  | { readonly kind: 'ref'; readonly ref: string }
  | { readonly kind: 'range'; readonly base: string; readonly head: string }

/**
 * Whether `ref` is a branch name or commit that is safe to hand to git: letters, digits and
 * `_ . / -`, not starting with `-` or `/`, and none of the sequences git gives meaning to.
 */
export function isPlainRef(ref: string): boolean {
  return (
    /^[\w./-]+$/.test(ref) &&
    !/^[-/.]/.test(ref) &&
    !ref.endsWith('/') &&
    !ref.endsWith('.') &&
    !ref.endsWith('.lock') &&
    !ref.includes('..') &&
    !ref.includes('//') &&
    !ref.includes('/.')
  )
}

/** Reads a comparison, or null when it is not one. */
export function parseComparison(value: string): ParsedComparison | null {
  if (value === 'session' || value === 'uncommitted') {
    return { kind: value }
  }

  if (value.startsWith('ref:')) {
    const ref = value.slice(4)

    return isPlainRef(ref) ? { kind: 'ref', ref } : null
  }

  if (value.startsWith('range:')) {
    const [base = '', head = '', ...rest] = value.slice(6).split('...')

    return rest.length === 0 && isPlainRef(base) && isPlainRef(head)
      ? { kind: 'range', base, head }
      : null
  }

  return null
}

/** One commit the session made, newest first. */
export const SandboxCommit = z.object({
  sha: z.string(),
  /** The tree it records. Two commits with the same tree hold the same files. */
  tree: z.string().optional(),
  subject: z.string(),
  /** When it was committed, in milliseconds. */
  at: z.number(),
  /** Local branches whose tip it is, such as a stack layer's branch. */
  branches: z.array(z.string()).readonly(),
})
export type SandboxCommit = z.infer<typeof SandboxCommit>

/**
 * How a repository's changes were measured, read from its sandbox. A saved copy only knows the
 * session's starting point and has none of this.
 */
export const SandboxComparison = z.object({
  /** The comparison applied. */
  against: Comparison,
  /** The commit the changes are measured from. Null when the reference was not found. */
  baseSha: z.string().nullable(),
  /**
   * `merge-base` when measured from where the two split, `tip` when they share no history in the
   * sandbox (a shallow clone) and the reference's own commit was used instead.
   */
  baseMode: z.enum(['merge-base', 'tip']).nullable(),
  /** The other side: null for the working tree, a commit for a range. */
  headSha: z.string().nullable(),
  /** Why nothing could be measured, such as a branch GitHub does not have. */
  error: z.string().nullable(),
})
export type SandboxComparison = z.infer<typeof SandboxComparison>

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
  /** The branch checked out in the session's worktree, and its commit. Unknown in a saved copy. */
  head: z
    .object({ branch: z.string().nullable(), sha: z.string(), tree: z.string().optional() })
    .nullable()
    .optional(),
  /** Whether the worktree has work that is not committed. Unknown in a saved copy. */
  dirty: z.boolean().optional(),
  /** Where the session started. Unknown in a saved copy. */
  sessionBaseSha: z.string().nullable().optional(),
  /** The session's commits, newest first, at most `MAX_SESSION_COMMITS`. */
  commits: z.array(SandboxCommit).readonly().optional(),
  /** How `changes` were measured. Absent in a saved copy, which measures from the start. */
  comparison: SandboxComparison.optional(),
  /**
   * What the session last published of each of its branches: the tree GitHub was given. Shuttle
   * publishes a branch by making the commit on GitHub, so that commit never has the sandbox's
   * name for it; the tree is what the two have in common.
   */
  published: z
    .array(z.object({ branch: z.string(), tree: z.string() }))
    .readonly()
    .optional(),
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

/** The most of a session's commits the workspace lists for each repository. */
export const MAX_SESSION_COMMITS = 50

/** A branch a repository's changes can be compared with. */
export const SandboxBranch = z.object({
  name: z.string(),
  /** Whether it is on GitHub, rather than only in the sandbox (as a stack layer may be). */
  remote: z.boolean(),
})
export type SandboxBranch = z.infer<typeof SandboxBranch>

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

  /**
   * One file, as it is now or, with `version: 'base'`, as it was where its changes are measured
   * from (`against`, the session's start when left out). `version: 'head'` is the other side of a
   * `range:` comparison, which is a commit rather than the file as it is now.
   */
  file: oc
    .route({ method: 'GET', path: '/sessions/{id}/sandbox/file' })
    .input(
      SessionParams.extend({
        path: FilePath,
        version: z.enum(['base', 'head']).optional(),
        against: Comparison.optional(),
      }),
    )
    .output(SandboxFile),

  /**
   * One file's changes, given `path`; every repository's without. Measured from the session's
   * start, or, for the file named, from `against`.
   */
  diff: oc
    .route({ method: 'GET', path: '/sessions/{id}/sandbox/diff' })
    .input(SessionParams.extend({ path: FilePath.optional(), against: Comparison.optional() }))
    .output(z.union([SandboxFileDiff, SandboxDiffs])),

  /**
   * The session's repositories and what changed in each. `against` measures a repository's
   * changes from something other than the session's start, by its directory name.
   */
  workspace: oc
    .route({ method: 'GET', path: '/sessions/{id}/sandbox/workspace' })
    .input(SessionParams.extend({ against: z.record(z.string(), Comparison).optional() }))
    .output(SandboxWorkspace),

  /**
   * The branches a repository's changes can be compared with: GitHub's, and the session's own.
   * Empty while the sandbox sleeps.
   */
  branches: oc
    .route({ method: 'GET', path: '/sessions/{id}/sandbox/branches' })
    .input(SessionParams.extend({ repo: z.string().min(1) }))
    .output(z.object({ branches: z.array(SandboxBranch).readonly() })),

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

/**
 * Workspace abstraction for coding tools.
 *
 * Spike findings (see SPIKE.md):
 * - Local effects inside a Looms Durable Object can call another DO over RPC.
 * - AbortSignal on ToolContext races the RPC; kill() cleans up when possible.
 * - Workers in one session share a single worktree per repo so edits are visible.
 * - D1 replica is optional; history tools degrade to in-run events when absent.
 */

import type {
  LayerAddress,
  LayerChangesetInput,
  NewLayerResult,
  SealLayerResult,
  StackStatus,
} from './stack'

export type {
  LayerAddress,
  LayerChangesetInput,
  NewLayerResult,
  SealLayerResult,
  StackStatus,
  StackStatusLayer,
  StackSummary,
} from './stack'

export interface ExecResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export interface LinkedSandboxRepo {
  readonly installationId: number
  readonly owner: string
  readonly name: string
  readonly fullName: string
  readonly defaultBranch: string
  readonly private: boolean
}

export interface WorktreeResult {
  readonly root: string
  readonly repoDirs: readonly { readonly name: string; readonly root: string }[]
}

export type ChangesetFileStatus = 'added' | 'modified' | 'deleted'

export interface ChangesetFile {
  readonly path: string
  readonly status: ChangesetFileStatus
  /** Null for deleted files. */
  readonly content: string | null
  /** Git mode; defaults to 100644 for blobs. */
  readonly mode?: string
}

export interface ChangesetResult {
  readonly baseSha: string
  readonly files: readonly ChangesetFile[]
}

export interface CheckoutRefInput {
  readonly sha: string
  readonly branch?: string
}

export interface ExecOptions {
  readonly cwd?: string
  readonly timeoutMs?: number
  /** Caller-chosen id so `kill(execId)` targets this command, not another worker's. */
  readonly execId?: string
}

export interface Workspace {
  ensureRepos(repos: readonly LinkedSandboxRepo[]): Promise<{ root: string }>
  ensureWorktree(runId: string): Promise<WorktreeResult>
  /**
   * Diff the shared worktree (local commits, staged, unstaged, and untracked files)
   * against the commit the session branched from, for publishing.
   */
  changeset(runId: string, repoName: string, baseBranch?: string): Promise<ChangesetResult>
  /** Commit-to-commit diff between a parent ref and a layer tip. */
  layerChangeset(
    runId: string,
    repoName: string,
    input: LayerChangesetInput,
  ): Promise<ChangesetResult>
  stackStatus(runId: string, repoName: string, defaultBranch: string): Promise<StackStatus>
  /** Commit pending edits on the current layer and restack the layers above it. */
  sealLayer(runId: string, repoName: string, message: string): Promise<SealLayerResult>
  /** Stack a layer on top of the current stack. */
  newLayer(runId: string, repoName: string, defaultBranch: string): Promise<NewLayerResult>
  /** Start an independent stack off the session base (a standalone PR). */
  newStack(runId: string, repoName: string, defaultBranch: string): Promise<NewLayerResult>
  checkoutLayer(
    runId: string,
    repoName: string,
    address: LayerAddress,
    defaultBranch: string,
  ): Promise<StackStatus>
  /** Load a PR head (or other ref) into the session worktree. */
  checkoutRef(
    runId: string,
    repo: LinkedSandboxRepo,
    ref: CheckoutRefInput,
  ): Promise<{ root: string }>
  readFile(path: string, cwd?: string): Promise<string>
  writeFile(path: string, content: string, cwd?: string): Promise<void>
  editFile(path: string, oldText: string, newText: string, cwd?: string): Promise<number>
  grep(pattern: string, path?: string, cwd?: string): Promise<string>
  listFiles(root: string): Promise<string[]>
  exec(command: string, options?: ExecOptions): Promise<ExecResult>
  gitDiff(cwd?: string): Promise<string>
  kill(execId?: string): Promise<void>
}

export function resolvePath(path: string, cwd?: string): string {
  if (path.startsWith('/')) {
    return path
  }

  const base = cwd ?? '/workspace'
  return `${base.replace(/\/$/, '')}/${path}`
}

export function repoCheckoutPath(repoName: string): string {
  return `/workspace/repos/${repoName}`
}

/** Shared session worktree root: one per run, not per worker thread. */
export function worktreeRoot(runId: string): string {
  return `/workspace/.wt/${runId}`
}

export function worktreeRepoPath(runId: string, repoName: string): string {
  return `${worktreeRoot(runId)}/${repoName}`
}

/**
 * Where a session's agents start: inside its repository when it works in one, and at the root of
 * its worktree when it works in several, so every repository is a directory beside the others.
 */
export function sessionWorkDir(runId: string, repos: readonly { readonly name: string }[]): string {
  return repos.length > 1 ? worktreeRoot(runId) : worktreeRepoPath(runId, repos[0]?.name ?? 'demo')
}

/**
 * Whether `path`, resolved against `cwd`, is inside the session's worktree. Anything written
 * elsewhere is not shown with the session's files, not saved, and not carried to a teammate's
 * sandbox.
 */
export function insideSessionWorktree(runId: string, path: string, cwd?: string): boolean {
  const parts: string[] = []

  for (const part of resolvePath(path, cwd).split('/')) {
    if (part === '..') {
      parts.pop()
    } else if (part && part !== '.') {
      parts.push(part)
    }
  }

  return `/${parts.join('/')}/`.startsWith(`${worktreeRoot(runId)}/`)
}

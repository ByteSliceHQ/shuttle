import { parseComparison, type SandboxCommit } from '@shuttle/api'

import type { PullInboxState, PullInboxSummary } from '../pulls/pulls'
import type { WorkspaceRepo } from './sandbox'

/**
 * What a repository's changes in the Workspace tab are measured against, and how that is told to
 * the people looking. A comparison is the string `Comparison` in `@shuttle/api` reads: `session`,
 * `uncommitted`, `ref:<ref>` or `range:<base>...<head>`.
 */

export const SESSION = 'session'

/** A pull request the session opened or is reviewing. */
export interface RunPull {
  readonly pull: PullInboxSummary
  readonly role: 'author' | 'reviewer'
}

/** Every pull request linked to the session: open ones first, then by repository and stack. */
export function runPulls(inbox: PullInboxState, runId: string): RunPull[] {
  return Object.values(inbox.pulls)
    .flatMap((pull) => {
      const link = pull.linkedSessions.find((session) => session.runId === runId)

      return link ? [{ pull, role: link.role }] : []
    })
    .toSorted(
      (a, b) =>
        Number(b.pull.state === 'open') - Number(a.pull.state === 'open') ||
        a.pull.fullName.localeCompare(b.pull.fullName) ||
        (a.pull.stack?.position ?? 0) - (b.pull.stack?.position ?? 0) ||
        a.pull.number - b.pull.number,
    )
}

/** The repository in the workspace a pull request is from, if it is one of them. */
export function repoOfPull(
  repos: readonly WorkspaceRepo[],
  pull: PullInboxSummary,
): WorkspaceRepo | undefined {
  return repos.find((repo) => repo.fullName === pull.fullName)
}

/**
 * The comparison that shows what a pull request changes. A review session has the pull request
 * checked out and already measures from its base. The branch checked out is compared from its
 * base to the working tree, so work not pushed yet shows too; any other layer of a stack is
 * compared commit to commit.
 */
export function pullComparison(run: RunPull, repo: WorkspaceRepo | undefined): string {
  const { pull } = run

  if (run.role === 'reviewer') {
    return SESSION
  }

  return repo?.head?.branch === pull.headRef
    ? `ref:${pull.baseRef}`
    : `range:${pull.baseRef}...${pull.headRef}`
}

/** The pull request a comparison shows, if it shows one. */
export function pullShown(
  against: string,
  pulls: readonly RunPull[],
  repo: WorkspaceRepo,
): RunPull | undefined {
  return pulls.find(
    (run) =>
      run.role === 'author' &&
      run.pull.state === 'open' &&
      repoOfPull([repo], run.pull) &&
      pullComparison(run, repo) === against,
  )
}

/** The commit the sandbox has at the tip of a branch, and its tree, as the session's commits say. */
function tipOf(
  repo: WorkspaceRepo,
  branch: string,
): { readonly sha: string; readonly tree?: string } | undefined {
  if (repo.head?.branch === branch) {
    return repo.head
  }

  return repo.commits?.find((commit) => commit.branches.includes(branch))
}

/**
 * Whether GitHub has what the sandbox has for a pull request: `pushed` when its head is the
 * branch's tip with nothing left uncommitted on it, `unpushed` when the sandbox has commits
 * GitHub does not, `uncommitted` when the branch is checked out with work not committed yet.
 * Null when it cannot be told, as from a saved copy.
 *
 * A branch the session published is on GitHub as a commit GitHub made, under another name than
 * the sandbox's, so the two are compared by the files they hold: the tree last published and the
 * tree at the branch's tip. Any other branch is compared by its commit.
 */
export function pullSync(
  pull: PullInboxSummary,
  repo: WorkspaceRepo | undefined,
): 'pushed' | 'unpushed' | 'uncommitted' | null {
  if (!repo?.head || pull.state !== 'open') {
    return null
  }

  const tip = tipOf(repo, pull.headRef)

  if (!tip) {
    return null
  }

  const published = repo.published?.find((entry) => entry.branch === pull.headRef)

  const same =
    published && tip.tree
      ? published.tree === tip.tree
      : tip.sha === pull.headSha ||
        pull.headSha.startsWith(tip.sha) ||
        tip.sha.startsWith(pull.headSha)

  if (!same) {
    return 'unpushed'
  }

  return repo.head.branch === pull.headRef && repo.dirty ? 'uncommitted' : 'pushed'
}

/** One stop on the line from where the changes start to where they end. */
export type RailPoint =
  | { readonly kind: 'base'; readonly sha: string | null }
  | { readonly kind: 'commit'; readonly sha: string; readonly commit: SandboxCommit }
  | { readonly kind: 'worktree'; readonly dirty: boolean }

/** The session's history in order: where it started, its commits oldest first, the working tree. */
export function railPoints(repo: WorkspaceRepo): RailPoint[] {
  return [
    { kind: 'base', sha: repo.sessionBaseSha ?? null },
    ...(repo.commits ?? []).toReversed().map((commit) => ({
      kind: 'commit' as const,
      sha: commit.sha,
      commit,
    })),
    { kind: 'worktree', dirty: repo.dirty ?? false },
  ]
}

/**
 * The stretch of the rail the comparison covers: from the point it measures from (exclusive) to
 * the one it measures to. A base outside the session's history, such as another branch, is drawn
 * at the start. Null when nothing was measured.
 */
export function railSpan(
  repo: WorkspaceRepo,
  points: readonly RailPoint[],
): { readonly from: number; readonly to: number } | null {
  const comparison = repo.comparison

  if (comparison && !comparison.baseSha) {
    return null
  }

  const indexOf = (sha: string | null | undefined) =>
    sha ? points.findIndex((point) => 'sha' in point && point.sha === sha) : -1

  const from = Math.max(0, indexOf(comparison?.baseSha))
  const to = comparison?.headSha ? indexOf(comparison.headSha) : points.length - 1

  return to > from ? { from, to } : null
}

/** Where each of the session's pull requests sits on the rail, for the ones that can be placed. */
export function railBrackets(
  repo: WorkspaceRepo,
  points: readonly RailPoint[],
  pulls: readonly RunPull[],
): { readonly run: RunPull; readonly from: number; readonly to: number }[] {
  const tipIndex = (branch: string) => {
    const sha = repo.head?.branch === branch ? null : tipOf(repo, branch)?.sha

    // The branch checked out runs on to the working tree.
    return sha === null
      ? points.length - 1
      : sha
        ? points.findIndex((point) => 'sha' in point && point.sha === sha)
        : -1
  }

  return pulls.flatMap((run) => {
    if (run.role !== 'author' || run.pull.state !== 'open' || !repoOfPull([repo], run.pull)) {
      return []
    }

    const to = tipIndex(run.pull.headRef)
    const from = Math.max(0, tipIndex(run.pull.baseRef))

    return to > from ? [{ run, from, to }] : []
  })
}

/** The name a comparison goes by in the picker, given what the sandbox measured. */
export function comparisonTitle(
  against: string,
  repo: WorkspaceRepo,
  pulls: readonly RunPull[],
): string {
  const parsed = parseComparison(against)
  const shown = pullShown(against, pulls, repo)

  if (shown) {
    return `PR #${shown.pull.number}`
  }

  switch (parsed?.kind) {
    case 'uncommitted':
      return 'Uncommitted changes'

    case 'ref': {
      const commit = repo.commits?.find((item) => item.sha.startsWith(parsed.ref))

      return commit ? `Since ${shortSha(commit.sha)}` : `Compared with ${parsed.ref}`
    }

    case 'range':
      return `${parsed.head} from ${parsed.base}`
    default:
      return 'All changes in this session'
  }
}

/** A branch name this long or shorter is shown whole. */
const REF_WHOLE = 28

/** How much of the start and of the end of a longer name is kept. */
const REF_HEAD = 12
const REF_TAIL = 16

/**
 * A branch name short enough to read at a glance. A long one, such as the branch Shuttle makes
 * for a session, loses its middle: the start says whose it is and the end is what tells a
 * session's branches apart (`shuttle/o-…-stack/web/2`). Both ends are cut at a separator where
 * there is one, so what is left reads as whole words.
 */
export function shortRef(name: string): string {
  if (name.length <= REF_WHOLE) {
    return name
  }

  const start = name.slice(0, REF_HEAD)
  const end = name.slice(-REF_TAIL)
  const headCut = Math.max(start.lastIndexOf('/'), start.lastIndexOf('-'), start.lastIndexOf('_'))
  const tailCut = end.search(/[/_-]/)

  // A separator too near either end would leave too little to tell anything by.
  const head = headCut >= 3 ? start.slice(0, headCut + 1) : start
  const tail = tailCut >= 0 && end.length - tailCut >= 4 ? end.slice(tailCut) : end

  return `${head}…${tail}`
}

/** A commit as people read it: its first seven characters. */
export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : ''
}

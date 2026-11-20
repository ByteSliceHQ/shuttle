import { shellQuote } from './exec-argv'
import { repoCheckoutPath, worktreeRepoPath } from './workspace'
import { GIT_IGNORING, IGNORE_SETUP } from './workspace-summary'

/**
 * The paths in a session's workspace, and nothing else: what the message box offers after `@`.
 * The workspace summary measures changes and reads history as well, which is more than a picker
 * needs and more than it should wait for.
 *
 * A repository the session has a worktree for lists what git tracks or would track there, so new
 * files an agent made are in and ignored ones are not. One with no worktree yet, as in a session
 * that has not started work, lists the shared checkout's `HEAD`, which is where the worktree will
 * start.
 */

/** Most paths listed per repository. A picker needs the names, not a full inventory. */
export const MAX_PATHS_PER_REPO = 100_000

export interface WorktreePathsRepo {
  readonly name: string
  readonly files: readonly string[]
  /** Whether there were more than `MAX_PATHS_PER_REPO`. */
  readonly truncated: boolean
}

/** Paths written out as they are, not quoted, so names that are not ASCII read as written. */
const GIT = `${GIT_IGNORING} -c core.quotePath=false`

export function worktreePathsScript(runId: string, repoNames: readonly string[]): string {
  const limit = MAX_PATHS_PER_REPO + 1

  return [
    IGNORE_SETUP,
    ...repoNames.flatMap((name) => [
      `if cd ${shellQuote(worktreeRepoPath(runId, name))} 2>/dev/null && git rev-parse --git-dir >/dev/null 2>&1; then`,
      `echo ${shellQuote(`REPO ${name}`)}`,
      // Files git tracks or would track, minus the ones deleted from the working directory.
      `{ ${GIT} ls-files -co --exclude-standard; ${GIT} ls-files -d; } | sort | uniq -u | head -n ${limit} | sed 's/^/FILE /'`,
      `elif cd ${shellQuote(repoCheckoutPath(name))} 2>/dev/null && git rev-parse --verify -q HEAD >/dev/null 2>&1; then`,
      `echo ${shellQuote(`REPO ${name}`)}`,
      `${GIT} ls-tree -r --name-only HEAD | head -n ${limit} | sed 's/^/FILE /'`,
      'fi',
    ]),
    'rm -f "$ignore"',
  ].join('\n')
}

/** Reads what `worktreePathsScript` printed. A repository it found nothing for is left out. */
export function parseWorktreePaths(stdout: string): WorktreePathsRepo[] {
  const repos: { name: string; files: string[] }[] = []

  for (const line of stdout.split('\n')) {
    if (line.startsWith('REPO ')) {
      repos.push({ name: line.slice('REPO '.length), files: [] })
      continue
    }

    const current = repos.at(-1)

    if (current !== undefined && line.startsWith('FILE ') && line.length > 'FILE '.length) {
      current.files.push(line.slice('FILE '.length))
    }
  }

  return repos.map(({ name, files }) => ({
    name,
    files: files.slice(0, MAX_PATHS_PER_REPO),
    truncated: files.length > MAX_PATHS_PER_REPO,
  }))
}

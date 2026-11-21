/**
 * Where a session's repositories are checked out in its sandbox. Agents name files by their full
 * path under it; the workspace names them relative to it, as `<repository>/<path>`.
 */
export function worktreeRoot(runId: string): string {
  return `/workspace/.wt/${runId}`
}

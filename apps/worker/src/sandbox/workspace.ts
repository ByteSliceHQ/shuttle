/**
 * Workspace abstraction for coding tools.
 *
 * Spike findings (see SPIKE.md):
 * - Local effects inside a Looms Durable Object can call another DO over RPC.
 * - AbortSignal on ToolContext races the RPC; kill() cleans up when possible.
 * - Parallel child threads in one DO each get their own worktree path.
 * - D1 replica is optional; history tools degrade to in-run events when absent.
 */

export interface ExecResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export interface Workspace {
  ensureRepo(repoUrl: string | null): Promise<{ root: string }>
  ensureWorktree(threadId: string): Promise<{ root: string }>
  readFile(path: string, cwd?: string): Promise<string>
  writeFile(path: string, content: string, cwd?: string): Promise<void>
  editFile(path: string, oldText: string, newText: string, cwd?: string): Promise<number>
  grep(pattern: string, path?: string, cwd?: string): Promise<string>
  exec(command: string, options?: { cwd?: string; timeoutMs?: number }): Promise<ExecResult>
  gitDiff(cwd?: string): Promise<string>
  kill(pid?: number): Promise<void>
}

export function resolvePath(path: string, cwd?: string): string {
  if (path.startsWith('/')) {
    return path
  }

  const base = cwd ?? '/workspace'
  return `${base.replace(/\/$/, '')}/${path}`
}

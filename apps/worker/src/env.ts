import type { LinkedSandboxRepo, WorktreeResult } from './sandbox/workspace'

export interface ShuttleEnv {
  readonly LOOMS_RUN: DurableObjectNamespace
  readonly SANDBOX: DurableObjectNamespace
  readonly REPLICA?: D1Database
  readonly OPENROUTER_API_KEY?: string
  readonly LOOMS_MODEL?: string
  readonly SHUTTLE_WORKSPACE_MODE?: string
  readonly SHUTTLE_PLAYBOOK_RUN_ID?: string
  readonly SHUTTLE_WORKSPACE_RUN_ID?: string
  readonly SHUTTLE_WEB_URL?: string
  readonly GITHUB_APP_ID?: string
  readonly GITHUB_APP_SLUG?: string
  readonly GITHUB_APP_PRIVATE_KEY?: string
  readonly GITHUB_STATE_SECRET?: string
}

/** RPC surface of SessionSandbox / WorkspaceSandbox. */
export interface SessionSandboxStub {
  ensureRepos(repos: LinkedSandboxRepo[]): Promise<{ root: string }>
  ensureWorktree(runId: string, threadId: string): Promise<WorktreeResult>
  ensureRepo(repoUrl: string | null): Promise<{ root: string }>
  readFile(path: string, cwd?: string): Promise<{ content: string }>
  writeFile(path: string, content: string, cwd?: string): Promise<{ ok: true }>
  editFile(
    path: string,
    oldText: string,
    newText: string,
    cwd?: string,
  ): Promise<{ ok: true; replacements: number }>
  grep(pattern: string, path?: string, cwd?: string): Promise<{ matches: string }>
  exec(
    command: string,
    options?: { cwd?: string; timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>
  gitDiff(cwd?: string): Promise<{ diff: string }>
  kill(pid?: number): Promise<{ ok: true }>
}

export function sandboxStub(env: ShuttleEnv, sandboxName: string): SessionSandboxStub {
  return env.SANDBOX.getByName(sandboxName) as unknown as SessionSandboxStub
}

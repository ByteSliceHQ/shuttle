import type { ExecOptions, LinkedSandboxRepo, WorktreeResult } from './sandbox/workspace'

export interface ShuttleEnv {
  readonly LOOMS_RUN: DurableObjectNamespace
  readonly SANDBOX: DurableObjectNamespace
  readonly REPLICA?: D1Database
  readonly OPENROUTER_API_KEY?: string
  readonly LOOMS_MODEL?: string
  /** TypeSafe API key for Jev evaluator decisions (`TYPESAFE_AI_API_KEY`). */
  readonly TYPESAFE_AI_API_KEY?: string
  /** Optional Jev model id; defaults to `jev-latest`. */
  readonly JEV_MODEL?: string
  readonly SHUTTLE_WORKSPACE_MODE?: string
  readonly SHUTTLE_PLAYBOOK_RUN_ID?: string
  readonly SHUTTLE_WORKSPACE_RUN_ID?: string
  readonly SHUTTLE_WEB_URL?: string
  readonly SHUTTLE_PREVIEW_HOST?: string
  readonly GITHUB_APP_ID?: string
  readonly GITHUB_APP_SLUG?: string
  readonly GITHUB_APP_PRIVATE_KEY?: string
  readonly GITHUB_STATE_SECRET?: string
}

/** RPC surface of SessionSandbox / WorkspaceSandbox. */
export interface SessionSandboxStub {
  ensureRepos(repos: LinkedSandboxRepo[]): Promise<{ root: string }>
  ensureWorktree(runId: string): Promise<WorktreeResult>
  ensureRepo(repoUrl: string | null): Promise<{ root: string }>
  readFile(
    path: string,
    cwd?: string,
  ): Promise<{ content: string; missing?: false } | { content: null; missing: true; error: string }>
  writeFile(path: string, content: string, cwd?: string): Promise<{ ok: true }>
  editFile(
    path: string,
    oldText: string,
    newText: string,
    cwd?: string,
  ): Promise<{ ok: true; replacements: number }>
  grep(pattern: string, path?: string, cwd?: string): Promise<{ matches: string }>
  listFiles(root: string): Promise<{ files: string[] }>
  exec(
    command: string,
    options?: ExecOptions,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>
  gitDiff(cwd?: string): Promise<{ diff: string }>
  kill(execId?: string): Promise<{ ok: true }>
  getMode(): Promise<{ mode: 'memory' | 'container' }>
  fetch(request: Request): Promise<Response>
}

export function sandboxStub(env: ShuttleEnv, sandboxName: string): SessionSandboxStub {
  return env.SANDBOX.getByName(sandboxName) as unknown as SessionSandboxStub
}

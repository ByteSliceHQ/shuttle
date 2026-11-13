import type { DurableObjectNamespaceLike } from '@swirls/looms/cloudflare'

import type { EventFirehose } from './firehose/durable-object'
import type { LoomsRunStub } from './looms-stub'
import type { AgentEventsPage, AgentRunInput, AgentRunState } from './sandbox/agent-runs'
import type { SessionSandbox } from './sandbox/session-sandbox'
import type {
  ChangesetResult,
  CheckoutRefInput,
  ExecOptions,
  LayerAddress,
  LayerChangesetInput,
  LinkedSandboxRepo,
  NewLayerResult,
  SealLayerResult,
  StackStatus,
  WorktreeResult,
} from './sandbox/workspace'

export interface ShuttleEnv {
  /**
   * Typed by the RPC surface Shuttle calls, not by the class: Cloudflare's stub types cannot
   * expand a class whose methods take recursive JSON.
   */
  readonly LOOMS_RUN: DurableObjectNamespaceLike<LoomsRunStub>
  readonly SANDBOX: DurableObjectNamespace<SessionSandbox>
  readonly EVENT_FIREHOSE: DurableObjectNamespace<EventFirehose>
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
  readonly GITHUB_WEBHOOK_SECRET?: string
  /**
   * Optional user/PAT token. Used when the GitHub App lacks `pull_requests`
   * (and related) scopes so local inbox sync and PR create still work.
   */
  readonly GITHUB_TOKEN?: string
  readonly SHUTTLE_PULLS_RUN_ID?: string
  /** Long random secret that encrypts stored vendor agent credentials. */
  readonly SHUTTLE_CREDENTIALS_KEY?: string
}

/** RPC surface of SessionSandbox / WorkspaceSandbox. */
export interface SessionSandboxStub {
  ensureRepos(repos: readonly LinkedSandboxRepo[]): Promise<{ root: string }>
  ensureWorktree(runId: string): Promise<WorktreeResult>
  ensureRepo(repoUrl: string | null): Promise<{ root: string }>
  changeset(runId: string, repoName: string, baseBranch?: string): Promise<ChangesetResult>
  layerChangeset(
    runId: string,
    repoName: string,
    input: LayerChangesetInput,
  ): Promise<ChangesetResult>
  stackStatus(runId: string, repoName: string, defaultBranch: string): Promise<StackStatus>
  sealLayer(runId: string, repoName: string, message: string): Promise<SealLayerResult>
  newLayer(runId: string, repoName: string, defaultBranch: string): Promise<NewLayerResult>
  newStack(runId: string, repoName: string, defaultBranch: string): Promise<NewLayerResult>
  checkoutLayer(
    runId: string,
    repoName: string,
    address: LayerAddress,
    defaultBranch: string,
  ): Promise<StackStatus>
  checkoutRef(
    runId: string,
    repo: LinkedSandboxRepo,
    ref: CheckoutRefInput,
  ): Promise<{ root: string }>
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
  startAgentRun(input: AgentRunInput): Promise<{ started: boolean }>
  readAgentEvents(runKey: string, offset: number): Promise<AgentEventsPage>
  agentRunState(runKey: string): Promise<{ state: AgentRunState }>
  stopAgentRun(runKey: string): Promise<{ ok: true }>
  sendAgentInput(runKey: string, text: string): Promise<{ ok: true }>
  collectAgentFiles(paths: readonly string[]): Promise<{ files: Record<string, string> }>
  listAgentModels(harness: string): Promise<{ models: unknown[] }>
  fetch(request: Request): Promise<Response>
}

export function sandboxStub(env: ShuttleEnv, sandboxName: string): SessionSandboxStub {
  return env.SANDBOX.getByName(sandboxName)
}

import type { DurableObjectNamespaceLike } from '@swirls/looms/cloudflare'

import type { EventFirehose } from './firehose/durable-object'
import type { LoomsRunStub } from './looms-stub'
import type { AgentEventsPage, AgentRunInput, AgentRunState } from './sandbox/agent-runs'
import type { SandboxMachineInfo } from './sandbox/providers/types'
import type { SessionSandbox } from './sandbox/session-sandbox'
import type { SessionSnapshot } from './sandbox/session-sync'
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
import type { SummaryRepo, WorkspaceSummary } from './sandbox/workspace-summary'

export interface ShuttleEnv {
  /**
   * Typed by the RPC surface Shuttle calls, not by the class: Cloudflare's stub types cannot
   * expand a class whose methods take recursive JSON.
   */
  readonly LOOMS_RUN: DurableObjectNamespaceLike<LoomsRunStub>
  readonly SANDBOX: DurableObjectNamespace<SessionSandbox>
  readonly EVENT_FIREHOSE: DurableObjectNamespace<EventFirehose>
  /** The built web app, in a deployment. Absent in development, where Vite serves it. */
  readonly WEB?: Fetcher
  /** Where uploaded and agent-made media is stored. Without it, attachments are unavailable. */
  readonly ASSETS?: R2Bucket
  readonly REPLICA?: D1Database
  /** Accounts, organizations and sign-in sessions (Better Auth), plus tenancy tables. */
  readonly AUTH_DB?: D1Database
  /** Signs sign-in sessions. At least 32 random characters. */
  readonly BETTER_AUTH_SECRET?: string
  /** When set, creating an account needs this code. See `auth/signup-code.ts`. */
  readonly SHUTTLE_SIGNUP_CODE?: string
  /** GitHub OAuth client for "Sign in with GitHub". Optional; email and password always work. */
  readonly GITHUB_CLIENT_ID?: string
  readonly GITHUB_CLIENT_SECRET?: string
  readonly OPENROUTER_API_KEY?: string
  readonly LOOMS_MODEL?: string
  /** TypeSafe API key for Jev evaluator decisions (`TYPESAFE_AI_API_KEY`). */
  readonly TYPESAFE_AI_API_KEY?: string
  /** Optional Jev model id; defaults to `jev-latest`. */
  readonly JEV_MODEL?: string
  /**
   * The provider the deployment's own sandboxes run on: `memory` (default), `container`
   * (Cloudflare) or `daytona`. A sandbox on a person's machine is local whatever this says.
   */
  readonly SHUTTLE_WORKSPACE_MODE?: string
  readonly DAYTONA_API_KEY?: string
  readonly DAYTONA_API_URL?: string
  readonly DAYTONA_TARGET?: string
  /** Daytona snapshot built from `apps/worker/Dockerfile`: the agent CLIs and the bridge. */
  readonly DAYTONA_SNAPSHOT?: string
  /** Code Storage organization name and signing key. */
  readonly PIERRE_ORG?: string
  readonly PIERRE_PRIVATE_KEY?: string
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
  snapshotSession(
    runId: string,
    repo: LinkedSandboxRepo,
  ): Promise<{ snapshot: SessionSnapshot | null }>
  restoreSession(
    runId: string,
    repo: LinkedSandboxRepo,
    snapshot: SessionSnapshot,
  ): Promise<{ ok: true }>
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
  readBytes(
    path: string,
    maxBytes: number,
    cwd?: string,
  ): Promise<{ bytes: Uint8Array | null; size: number | null }>
  writeBytes(path: string, content: Uint8Array, cwd?: string): Promise<{ ok: true }>
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
  workspaceSummary(runId: string, repos: readonly SummaryRepo[]): Promise<WorkspaceSummary>
  fileDiff(runId: string, repo: SummaryRepo, path: string): Promise<{ diff: string }>
  baseFile(
    runId: string,
    repo: SummaryRepo,
    path: string,
    version?: 'base' | 'head',
  ): Promise<{ content: string | null }>
  adoptStray(
    runId: string,
    repoName: string,
    stray: string,
  ): Promise<{ ok: boolean; error?: string }>
  kill(execId?: string): Promise<{ ok: true }>
  getMode(): Promise<{ mode: 'memory' | 'container' }>
  isAwake(): Promise<{ awake: boolean }>
  describe(): Promise<SandboxMachineInfo>
  disconnect(): Promise<{ ok: true }>
  isBusy(): Promise<{ busy: boolean }>
  startAgentRun(input: AgentRunInput): Promise<{ started: boolean }>
  readAgentEvents(runKey: string, offset: number): Promise<AgentEventsPage>
  agentRunState(runKey: string): Promise<{ state: AgentRunState }>
  readAgentLog(runKey: string): Promise<{ log: string }>
  stopAgentRun(runKey: string): Promise<{ ok: true }>
  sendAgentInput(runKey: string, text: string): Promise<{ ok: true }>
  collectAgentFiles(paths: readonly string[]): Promise<{ files: Record<string, string> }>
  listAgentModels(harness: string): Promise<{ models: unknown[] }>
  fetch(request: Request): Promise<Response>
}

export function sandboxStub(env: ShuttleEnv, sandboxName: string): SessionSandboxStub {
  return env.SANDBOX.getByName(sandboxName)
}

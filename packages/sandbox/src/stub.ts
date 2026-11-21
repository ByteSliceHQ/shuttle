import type { AgentEventsPage, AgentRunInput, AgentRunState } from './agent-runs'
import type { SandboxMachineInfo } from './providers/types'
import type { SessionSandbox } from './session-sandbox'
import type { SessionSnapshot } from './session-sync'
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
} from './workspace'
import type { SummaryRepo, WorkspaceSummary } from './workspace-summary'

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

/** The binding a host gives the sandbox package: the Durable Object namespace of `SessionSandbox`. */
export interface SandboxBindingEnv {
  readonly SANDBOX: DurableObjectNamespace<SessionSandbox>
}

export function sandboxStub(env: SandboxBindingEnv, sandboxName: string): SessionSandboxStub {
  return env.SANDBOX.getByName(sandboxName)
}

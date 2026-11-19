import { SandboxFileError } from '@cloudflare/sandbox'
import { DurableObject } from 'cloudflare:workers'

import {
  agentRunState,
  collectAgentFiles,
  listAgentModels,
  readAgentEvents,
  readAgentLog,
  sendAgentInput,
  startAgentRun,
  stopAgentRun,
  type AgentEventsPage,
  type AgentRunContainer,
  type AgentRunInput,
  type AgentRunState,
} from './agent-runs'
import type { SandboxEnv } from './env'
import { shellQuote } from './exec-argv'
import type { SandboxHost } from './host'
import { isDemoRepo, orgOfSandbox } from './names'
import { parsePreviewHost } from './preview-host'
import { openSandbox } from './providers/registry'
import type { SandboxMachine, SandboxMachineInfo } from './providers/types'
import { sessionRemote } from './repo-access'
import { restoreSession, snapshotSession, type SessionSnapshot } from './session-sync'
import { resolvePath, worktreeRepoPath } from './workspace'
import type {
  ChangesetResult,
  CheckoutRefInput,
  ExecOptions,
  ExecResult,
  LayerAddress,
  LayerChangesetInput,
  LinkedSandboxRepo,
  NewLayerResult,
  SealLayerResult,
  StackStatus,
  Workspace,
  WorktreeResult,
} from './workspace'
import {
  adoptStrayScript,
  baseFileScript,
  fileDiffScript,
  isAdoptable,
  parseWorkspaceSummary,
  workspaceSummaryScript,
  type SummaryRepo,
  type WorkspaceSummary,
} from './workspace-summary'

/**
 * One sandbox Durable Object per place a session can work: a workspace folder
 * (`folder:<folderId>`), a person's cloud sandbox (`user:<orgId>:<userId>`) or one of their own
 * machines (`local:<orgId>:<userId>:<deviceId>`). Legacy sessions may still use a run id.
 *
 * What the sandbox runs on is its provider's business (see `providers/`). This object is the
 * same for all of them: it serializes setup, answers the RPC surface in `env.ts`, and moves a
 * session's work in and out through Code Storage.
 */

/** Longest a look at the session's files may take, in milliseconds. */
const SUMMARY_TIMEOUT_MS = 30_000

export class SessionSandbox extends DurableObject<SandboxEnv> {
  private readonly machine: SandboxMachine
  private preparedRepos = false

  /**
   * Repository and worktree setup run one at a time. Tool calls arrive concurrently, and a
   * worktree cut while a clone is still running starts from a repository with no HEAD.
   */
  private setup: Promise<unknown> = Promise.resolve()

  constructor(ctx: DurableObjectState, env: SandboxEnv) {
    super(ctx, env)
    this.machine = openSandbox({ ctx, env, name: ctx.id.name ?? 'unnamed' })
  }

  /** The machine this sandbox runs on. Not available for a sandbox kept in memory. */
  private host(): Promise<SandboxHost> {
    return this.machine.host()
  }

  private workspace(): Promise<Workspace> {
    return this.machine.workspace()
  }

  private serializeSetup<T>(task: () => Promise<T>): Promise<T> {
    const run = this.setup.then(task, task)

    this.setup = run.catch(() => undefined)

    return run
  }

  async ensureRepos(repos: readonly LinkedSandboxRepo[]): Promise<{ root: string }> {
    return this.serializeSetup(async () => {
      const result = await (await this.workspace()).ensureRepos(repos)
      this.preparedRepos = true
      return result
    })
  }

  async ensureWorktree(runId: string): Promise<WorktreeResult> {
    return this.serializeSetup(async () => {
      const workspace = await this.workspace()

      if (!this.preparedRepos) {
        await workspace.ensureRepos([])
        this.preparedRepos = true
      }

      return workspace.ensureWorktree(runId)
    })
  }

  async changeset(runId: string, repoName: string, baseBranch?: string): Promise<ChangesetResult> {
    return (await this.workspace()).changeset(runId, repoName, baseBranch)
  }

  async layerChangeset(
    runId: string,
    repoName: string,
    input: LayerChangesetInput,
  ): Promise<ChangesetResult> {
    return (await this.workspace()).layerChangeset(runId, repoName, input)
  }

  async stackStatus(runId: string, repoName: string, defaultBranch: string): Promise<StackStatus> {
    return (await this.workspace()).stackStatus(runId, repoName, defaultBranch)
  }

  async sealLayer(runId: string, repoName: string, message: string): Promise<SealLayerResult> {
    return (await this.workspace()).sealLayer(runId, repoName, message)
  }

  async newLayer(runId: string, repoName: string, defaultBranch: string): Promise<NewLayerResult> {
    return (await this.workspace()).newLayer(runId, repoName, defaultBranch)
  }

  async newStack(runId: string, repoName: string, defaultBranch: string): Promise<NewLayerResult> {
    return (await this.workspace()).newStack(runId, repoName, defaultBranch)
  }

  async checkoutLayer(
    runId: string,
    repoName: string,
    address: LayerAddress,
    defaultBranch: string,
  ): Promise<StackStatus> {
    return (await this.workspace()).checkoutLayer(runId, repoName, address, defaultBranch)
  }

  async checkoutRef(
    runId: string,
    repo: LinkedSandboxRepo,
    ref: CheckoutRefInput,
  ): Promise<{ root: string }> {
    return this.serializeSetup(async () => (await this.workspace()).checkoutRef(runId, repo, ref))
  }

  /** @deprecated Prefer ensureRepos. */
  async ensureRepo(repoUrl: string | null): Promise<{ root: string }> {
    if (repoUrl === null || repoUrl === '') {
      return this.ensureRepos([])
    }

    const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/)

    if (!match) {
      return this.ensureRepos([])
    }

    return this.ensureRepos([
      {
        installationId: 0,
        owner: match[1] ?? '',
        name: match[2] ?? '',
        fullName: `${match[1]}/${match[2]}`,
        defaultBranch: 'main',
        private: false,
      },
    ])
  }

  async readFile(
    path: string,
    cwd?: string,
  ): Promise<
    { content: string; missing?: false } | { content: null; missing: true; error: string }
  > {
    try {
      return { content: await (await this.workspace()).readFile(path, cwd) }
    } catch (cause) {
      // Missing paths are normal (stale File tabs, agent race). Return structured
      // absence instead of throwing so wrangler doesn't log Uncaught SandboxFileError.
      if (
        SandboxFileError.is(cause) ||
        (cause instanceof Error && /ENOENT|No such file/i.test(cause.message))
      ) {
        return {
          content: null,
          missing: true,
          error: cause instanceof Error ? cause.message : String(cause),
        }
      }

      throw cause
    }
  }

  async writeFile(path: string, content: string, cwd?: string): Promise<{ ok: true }> {
    await (await this.workspace()).writeFile(path, content, cwd)
    return { ok: true }
  }

  /**
   * A file's bytes, or `null` when it is missing or larger than `maxBytes`. The size is checked
   * in the sandbox first so an oversized file is never read into the Worker.
   */
  async readBytes(
    path: string,
    maxBytes: number,
    cwd?: string,
  ): Promise<{ bytes: Uint8Array | null; size: number | null }> {
    const workspace = await this.workspace()

    if (this.machine.kind !== 'memory') {
      const sized = await workspace.exec(`stat -c %s -- ${shellQuote(resolvePath(path, cwd))}`, {
        timeoutMs: 15_000,
      })

      const size = Number(sized.stdout.trim())

      if (sized.exitCode !== 0 || !Number.isFinite(size)) {
        return { bytes: null, size: null }
      }

      if (size > maxBytes) {
        return { bytes: null, size }
      }
    }

    try {
      const bytes = await workspace.readBytes(path, cwd)

      return bytes.byteLength > maxBytes
        ? { bytes: null, size: bytes.byteLength }
        : { bytes, size: bytes.byteLength }
    } catch {
      return { bytes: null, size: null }
    }
  }

  async writeBytes(path: string, content: Uint8Array, cwd?: string): Promise<{ ok: true }> {
    await (await this.workspace()).writeBytes(path, content, cwd)
    return { ok: true }
  }

  async editFile(
    path: string,
    oldText: string,
    newText: string,
    cwd?: string,
  ): Promise<{ ok: true; replacements: number }> {
    const replacements = await (await this.workspace()).editFile(path, oldText, newText, cwd)
    return { ok: true, replacements }
  }

  async grep(pattern: string, path?: string, cwd?: string): Promise<{ matches: string }> {
    return { matches: await (await this.workspace()).grep(pattern, path, cwd) }
  }

  async listFiles(root: string): Promise<{ files: string[] }> {
    return { files: await (await this.workspace()).listFiles(root) }
  }

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    return (await this.workspace()).exec(command, options)
  }

  /**
   * Whether this sandbox is running right now. Asking never starts it, which is the point: a
   * caller that only wants to look uses this to decide whether to look here or at what was saved.
   */
  async isAwake(): Promise<{ awake: boolean }> {
    return { awake: await this.machine.isAwake() }
  }

  /** Whether this is a real Linux sandbox, for UI feature gates (terminal / browser). */
  async getMode(): Promise<{ mode: 'memory' | 'container' }> {
    return { mode: this.machine.kind }
  }

  /** What is known about the machine behind this sandbox, for showing to people. */
  async describe(): Promise<SandboxMachineInfo> {
    return (await this.machine.describe?.()) ?? { online: await this.machine.isAwake() }
  }

  /** Whether a command is running here right now, which a snapshot taken now would miss. */
  async isBusy(): Promise<{ busy: boolean }> {
    return { busy: (await this.workspace()).busy?.() ?? false }
  }

  /** Cuts off whatever keeps this sandbox connected from outside, such as a machine's runner. */
  async disconnect(): Promise<{ ok: true }> {
    await this.machine.disconnect?.()

    return { ok: true }
  }

  /** The session's files and what it has changed, repository by repository. */
  async workspaceSummary(runId: string, repos: readonly SummaryRepo[]): Promise<WorkspaceSummary> {
    const result = await (
      await this.workspace()
    ).exec(workspaceSummaryScript(runId, repos), { timeoutMs: SUMMARY_TIMEOUT_MS })

    return parseWorkspaceSummary(result.stdout)
  }

  /** One file's changes, from where `repo.against` measures (the session's start), as a unified diff. */
  async fileDiff(runId: string, repo: SummaryRepo, path: string): Promise<{ diff: string }> {
    const result = await (
      await this.workspace()
    ).exec(fileDiffScript(repo.defaultBranch, path, repo.against), {
      cwd: worktreeRepoPath(runId, repo.name),
      timeoutMs: SUMMARY_TIMEOUT_MS,
    })

    return { diff: result.stdout }
  }

  /**
   * One file as it was where `repo.against` measures from (the session's start), or, as `head`,
   * at the commit it measures to. Null when it did not exist there.
   */
  async baseFile(
    runId: string,
    repo: SummaryRepo,
    path: string,
    version: 'base' | 'head' = 'base',
  ): Promise<{ content: string | null }> {
    const result = await (
      await this.workspace()
    ).exec(baseFileScript(repo.defaultBranch, path, repo.against, version), {
      cwd: worktreeRepoPath(runId, repo.name),
      timeoutMs: SUMMARY_TIMEOUT_MS,
    })

    return { content: result.exitCode === 0 ? result.stdout : null }
  }

  /** Moves something an agent left under /workspace into one of the session's repositories. */
  async adoptStray(
    runId: string,
    repoName: string,
    stray: string,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!isAdoptable(stray)) {
      return { ok: false, error: `${stray} cannot be moved into the workspace` }
    }

    const result = await (
      await this.workspace()
    ).exec(adoptStrayScript(stray, worktreeRepoPath(runId, repoName)))

    const reason = result.stderr.trim()

    return result.exitCode === 0
      ? { ok: true }
      : { ok: false, error: reason === '' ? 'Could not move it' : reason }
  }

  async gitDiff(cwd?: string): Promise<{ diff: string }> {
    return { diff: await (await this.workspace()).gitDiff(cwd) }
  }

  async kill(execId?: string): Promise<{ ok: true }> {
    await (await this.workspace()).kill(execId)
    return { ok: true }
  }

  /**
   * Pushes a session's work for one repository to its branches on Code Storage, so another
   * sandbox can pick it up. Null when this sandbox has no worktree for the session.
   */
  async snapshotSession(
    runId: string,
    repo: LinkedSandboxRepo,
  ): Promise<{ snapshot: SessionSnapshot | null }> {
    return this.serializeSetup(async () => {
      const { workspace, remote } = await this.syncEnds(runId, repo)

      const present = await workspace.exec(
        `test -e ${shellQuote(`${worktreeRepoPath(runId, repo.name)}/.git`)}`,
      )

      return {
        snapshot:
          present.exitCode === 0
            ? await snapshotSession(workspace, runId, repo.name, remote, repo.defaultBranch)
            : null,
      }
    })
  }

  /** Rebuilds a session's worktree for one repository from a snapshot another sandbox pushed. */
  async restoreSession(
    runId: string,
    repo: LinkedSandboxRepo,
    snapshot: SessionSnapshot,
  ): Promise<{ ok: true }> {
    return this.serializeSetup(async () => {
      const { workspace, remote } = await this.syncEnds(runId, repo)

      // With no linked repository the sandbox seeds its own, which the session's branch is
      // then fetched into.
      await workspace.ensureRepos(isDemoRepo(repo) ? [] : [repo])
      this.preparedRepos = true
      await restoreSession(workspace, runId, remote, snapshot)

      return { ok: true }
    })
  }

  private async syncEnds(runId: string, repo: LinkedSandboxRepo) {
    const remote = await sessionRemote(this.env, repo, orgOfSandbox(this.ctx.id.name ?? ''), runId)

    if (!remote) {
      throw new Error(
        'Moving a session between sandboxes needs Code Storage (PIERRE_ORG and PIERRE_PRIVATE_KEY).',
      )
    }

    return { workspace: await this.workspace(), remote }
  }

  /** The running container for vendor agent runs. They cannot run in memory mode. */
  private async agentContainer(): Promise<AgentRunContainer> {
    return this.host()
  }

  /** Starts a vendor agent turn or sign-in. Returns at once; follow it with readAgentEvents. */
  async startAgentRun(input: AgentRunInput): Promise<{ started: boolean }> {
    return startAgentRun(await this.agentContainer(), input)
  }

  async readAgentEvents(runKey: string, offset: number): Promise<AgentEventsPage> {
    return readAgentEvents(await this.agentContainer(), runKey, offset)
  }

  async agentRunState(runKey: string): Promise<{ state: AgentRunState }> {
    return { state: await agentRunState(await this.agentContainer(), runKey) }
  }

  /** The end of a run's bridge output, for explaining a run that died. */
  async readAgentLog(runKey: string): Promise<{ log: string }> {
    return { log: await readAgentLog(await this.agentContainer(), runKey) }
  }

  async stopAgentRun(runKey: string): Promise<{ ok: true }> {
    await stopAgentRun(await this.agentContainer(), runKey)
    return { ok: true }
  }

  async sendAgentInput(runKey: string, text: string): Promise<{ ok: true }> {
    await sendAgentInput(await this.agentContainer(), runKey, text)
    return { ok: true }
  }

  /** Reads an agent's sign-in files so they can be stored and placed again in a new container. */
  async collectAgentFiles(paths: readonly string[]): Promise<{ files: Record<string, string> }> {
    return { files: await collectAgentFiles(await this.agentContainer(), paths) }
  }

  /** The models an agent reports for itself. The caller validates them. */
  async listAgentModels(harness: string): Promise<{ models: unknown[] }> {
    return { models: await listAgentModels(await this.agentContainer(), harness) }
  }

  /**
   * HTTP entry for terminal WebSockets, container port previews, and whatever else the
   * sandbox's provider answers. Preview hosts look like `p3000-<folderId>.preview.example`.
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const preview = parsePreviewHost(url.hostname)

    if (preview) {
      return this.machine.preview(request, preview.port)
    }

    if (url.pathname.includes('/sandbox/terminal')) {
      return this.machine.terminal(request)
    }

    return (await this.machine.fetch?.(request)) ?? new Response('Not Found', { status: 404 })
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.machine.webSocketMessage?.(socket, message)
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    await this.machine.webSocketClose?.(socket)
  }
}

/** Preferred name; class remains SessionSandbox for the existing Durable Object binding. */
export { SessionSandbox as WorkspaceSandbox }

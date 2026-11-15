import { SandboxFileError } from '@cloudflare/sandbox'
import { DurableObject } from 'cloudflare:workers'

import type { ShuttleEnv } from '../env'
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
import {
  ensureContainerRunning,
  reapplyInactivityTimeout,
  requireContainerMode,
} from './container-runtime'
import { ContainerWorkspace } from './container-workspace'
import {
  connectDaytonaSandbox,
  isDaytonaOwnError,
  openDaytonaTerminal,
  peekDaytonaSandbox,
  proxyDaytonaPreview,
  sandboxNotRunning,
} from './daytona'
import { daytonaHost } from './daytona-host'
import { shellQuote } from './exec-argv'
import { cloudflareHost, type SandboxHost } from './host'
import { MemoryWorkspace } from './memory-workspace'
import { isDemoRepo, orgOfSandbox } from './names'
import { parsePreviewHost } from './preview-host'
import { previewUnavailableResponse, proxyContainerPreview } from './preview-proxy'
import { sessionRemote } from './repo-access'
import { restoreSession, snapshotSession, type SessionSnapshot } from './session-sync'
import { openContainerTerminal } from './terminal'
import { worktreeRepoPath } from './workspace'
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
 * One sandbox Durable Object per workspace folder (named `folder:<folderId>`).
 * Legacy sessions may still use a run id as the DO name.
 *
 * Modes:
 * - `memory` (default): in-DO filesystem + GitHub tarball import, no Docker required.
 * - `container`: real Linux via Durable Object containers + `@cloudflare/sandbox` Files.
 * - `daytona`: real Linux in a Daytona sandbox named after this object, which keeps its disk
 *   when it stops.
 */
/** How long a Daytona sandbox is assumed to still be running before it is checked again. */
const DAYTONA_RECHECK_MS = 60_000

/** Longest a look at the session's files may take, in milliseconds. */
const SUMMARY_TIMEOUT_MS = 30_000

/** How long an answer to "is it running?" is reused. The Files tab asks every few seconds. */
const DAYTONA_PEEK_MS = 10_000

type DaytonaSandbox = Awaited<ReturnType<typeof connectDaytonaSandbox>>

export class SessionSandbox extends DurableObject<ShuttleEnv> {
  private memory: MemoryWorkspace | null = null
  private containerWs: ContainerWorkspace | null = null
  private daytona: { sandbox: DaytonaSandbox; checkedAt: number } | null = null
  private connecting: Promise<DaytonaSandbox> | null = null
  private peeked: { awake: boolean; at: number } | null = null
  private preparedRepos = false

  /**
   * Repository and worktree setup run one at a time. Tool calls arrive concurrently, and a
   * worktree cut while a clone is still running starts from a repository with no HEAD.
   */
  private setup: Promise<unknown> = Promise.resolve()

  constructor(ctx: DurableObjectState, env: ShuttleEnv) {
    super(ctx, env)
    reapplyInactivityTimeout(ctx)
  }

  private mode(): 'memory' | 'container' | 'daytona' {
    const mode = this.env.SHUTTLE_WORKSPACE_MODE

    return mode === 'container' || mode === 'daytona' ? mode : 'memory'
  }

  /** The Daytona sandbox behind this object, started if it had stopped. Checked once a minute. */
  private async daytonaSandbox(): Promise<DaytonaSandbox> {
    const known = this.daytona

    if (known && Date.now() - known.checkedAt < DAYTONA_RECHECK_MS) {
      return known.sandbox
    }

    // A page loading in the preview asks many times at once. They share one wake-up: Daytona
    // refuses a second start while the first is under way.
    this.connecting ??= connectDaytonaSandbox(this.env, this.ctx.id.name ?? 'unnamed')
      .then((sandbox) => {
        this.daytona = { sandbox, checkedAt: Date.now() }

        return sandbox
      })
      .finally(() => {
        this.connecting = null
      })

    return this.connecting
  }

  /**
   * Runs `use` against the Daytona sandbox. If it turns out to have gone to sleep since it was
   * last checked, it is woken and `use` runs once more: Daytona turned the first attempt away
   * before it reached the sandbox, so nothing ran twice.
   */
  private async withDaytona<T>(use: (sandbox: DaytonaSandbox) => Promise<T>): Promise<T> {
    try {
      return await use(await this.daytonaSandbox())
    } catch (cause) {
      if (!sandboxNotRunning(cause)) {
        throw cause
      }

      this.daytona = null

      return use(await this.daytonaSandbox())
    }
  }

  /** The Daytona sandbox as a host whose every operation wakes it if it has gone to sleep. */
  private daytonaHost(): SandboxHost {
    return daytonaHost({
      process: {
        executeCommand: (command, cwd, env, timeout) =>
          this.withDaytona((sandbox) => sandbox.process.executeCommand(command, cwd, env, timeout)),
      },
      fs: {
        uploadFile: (file, remotePath) =>
          this.withDaytona((sandbox) => sandbox.fs.uploadFile(file, remotePath)),
        downloadFile: (remotePath) =>
          this.withDaytona((sandbox) => sandbox.fs.downloadFile(remotePath)),
      },
    })
  }

  /** A preview request, sent again after waking the sandbox if it had gone to sleep. */
  private async daytonaPreview(request: Request, port: number): Promise<Response> {
    // Split in case the request has to be sent twice; a body can only be read once.
    const [body, again] = request.body ? request.body.tee() : [null, null]
    const response = await proxyDaytonaPreview(request, await this.daytonaSandbox(), port, body)

    // Daytona answers for a sleeping sandbox with a 400 of its own, in JSON.
    if (
      response.status !== 400 ||
      !response.headers.get('content-type')?.includes('json') ||
      !sandboxNotRunning(await response.clone().text())
    ) {
      void again?.cancel().catch(() => {})

      return this.daytonaAnswer(request, port, response)
    }

    this.daytona = null

    return this.daytonaAnswer(
      request,
      port,
      await proxyDaytonaPreview(request, await this.daytonaSandbox(), port, again),
    )
  }

  /** A preview response, with Daytona's own errors replaced by ours so they never reach a person. */
  private async daytonaAnswer(
    request: Request,
    port: number,
    response: Response,
  ): Promise<Response> {
    if (!(await isDaytonaOwnError(response))) {
      return response
    }

    void response.body?.cancel().catch(() => {})

    return previewUnavailableResponse(request, port)
  }

  /** The machine this sandbox runs on. Not available in memory mode. */
  private async host(): Promise<SandboxHost> {
    const mode = this.mode()

    switch (mode) {
      case 'daytona':
        // Connected here so a sandbox that cannot start fails now, not on first use.
        await this.daytonaSandbox()

        return this.daytonaHost()
      case 'container':
        return cloudflareHost(await ensureContainerRunning(this.ctx.container))
      case 'memory':
        throw new Error('container-mode-required')

      default: {
        const exhaustive: never = mode

        return exhaustive
      }
    }
  }

  private async workspace(): Promise<Workspace> {
    if (this.mode() === 'memory') {
      this.memory ??= await MemoryWorkspace.restore(this.ctx.storage, this.env)
      this.memory.resetAbort()
      return this.memory
    }

    this.containerWs ??= new ContainerWorkspace(
      () => this.host(),
      this.env,
      orgOfSandbox(this.ctx.id.name ?? ''),
    )

    return this.containerWs
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
    if (!repoUrl) {
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

  /** Workspace mode for UI feature gates (terminal / browser). */
  /** Whether this is a real Linux sandbox. A Daytona sandbox is reported as a container. */
  /**
   * Whether this sandbox is running right now. Asking never starts it, which is the point: a
   * caller that only wants to look uses this to decide whether to look here or at what was saved.
   */
  async isAwake(): Promise<{ awake: boolean }> {
    if (this.mode() !== 'daytona') {
      return { awake: true }
    }

    const known = this.peeked

    if (known && Date.now() - known.at < DAYTONA_PEEK_MS) {
      return { awake: known.awake }
    }

    const state = await peekDaytonaSandbox(this.env, this.ctx.id.name ?? 'unnamed')
    const awake = state === 'started'

    this.peeked = { awake, at: Date.now() }

    return { awake }
  }

  async getMode(): Promise<{ mode: 'memory' | 'container' }> {
    return { mode: this.mode() === 'memory' ? 'memory' : 'container' }
  }

  /** The session's files and what it has changed, repository by repository. */
  async workspaceSummary(runId: string, repos: readonly SummaryRepo[]): Promise<WorkspaceSummary> {
    const result = await (
      await this.workspace()
    ).exec(workspaceSummaryScript(runId, repos), { timeoutMs: SUMMARY_TIMEOUT_MS })

    return parseWorkspaceSummary(result.stdout)
  }

  /** One file's changes since the session started, as a unified diff. */
  async fileDiff(runId: string, repo: SummaryRepo, path: string): Promise<{ diff: string }> {
    const result = await (
      await this.workspace()
    ).exec(fileDiffScript(repo.defaultBranch, path), {
      cwd: worktreeRepoPath(runId, repo.name),
      timeoutMs: SUMMARY_TIMEOUT_MS,
    })

    return { diff: result.stdout }
  }

  /** One file as it was when the session started. Null when it did not exist then. */
  async baseFile(
    runId: string,
    repo: SummaryRepo,
    path: string,
  ): Promise<{ content: string | null }> {
    const result = await (
      await this.workspace()
    ).exec(baseFileScript(repo.defaultBranch, path), {
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

    return result.exitCode === 0
      ? { ok: true }
      : { ok: false, error: result.stderr.trim() || 'Could not move it' }
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
   * HTTP entry for terminal WebSockets and container port previews.
   * Preview hosts look like `p3000-<folderId>.preview.example`.
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const preview = parsePreviewHost(url.hostname)

    if (preview) {
      if (this.mode() === 'daytona') {
        return this.daytonaPreview(request, preview.port)
      }

      const container = requireContainerMode(
        this.mode() === 'memory' ? 'memory' : 'container',
        this.ctx.container,
      )

      if (container instanceof Response) {
        return container
      }

      return proxyContainerPreview(request, container, preview.port)
    }

    if (url.pathname.includes('/sandbox/terminal')) {
      if (this.mode() === 'daytona') {
        return this.withDaytona((sandbox) => openDaytonaTerminal(request, sandbox))
      }

      const container = requireContainerMode(
        this.mode() === 'memory' ? 'memory' : 'container',
        this.ctx.container,
      )

      if (container instanceof Response) {
        return container
      }

      return openContainerTerminal(request, container)
    }

    return new Response('Not Found', { status: 404 })
  }
}

/** Preferred name; class remains SessionSandbox for the existing Durable Object binding. */
export { SessionSandbox as WorkspaceSandbox }

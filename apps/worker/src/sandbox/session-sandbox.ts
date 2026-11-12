import { SandboxFileError } from '@cloudflare/sandbox'
import { DurableObject } from 'cloudflare:workers'

import type { ShuttleEnv } from '../env'
import { reapplyInactivityTimeout, requireContainerMode } from './container-runtime'
import { ContainerWorkspace } from './container-workspace'
import { MemoryWorkspace } from './memory-workspace'
import { parsePreviewHost } from './preview-host'
import { proxyContainerPreview } from './preview-proxy'
import { openContainerTerminal } from './terminal'
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

/**
 * One sandbox Durable Object per workspace folder (named `folder:<folderId>`).
 * Legacy sessions may still use a run id as the DO name.
 *
 * Modes:
 * - `memory` (default): in-DO filesystem + GitHub tarball import, no Docker required.
 * - `container`: real Linux via Durable Object containers + `@cloudflare/sandbox` Files.
 */
export class SessionSandbox extends DurableObject<ShuttleEnv> {
  private memory: MemoryWorkspace | null = null
  private containerWs: ContainerWorkspace | null = null
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

  private mode(): 'memory' | 'container' {
    return this.env.SHUTTLE_WORKSPACE_MODE === 'container' ? 'container' : 'memory'
  }

  private async workspace(): Promise<Workspace> {
    if (this.mode() === 'memory') {
      this.memory ??= await MemoryWorkspace.restore(this.ctx.storage, this.env)
      this.memory.resetAbort()
      return this.memory
    }

    this.containerWs ??= new ContainerWorkspace(() => this.ctx.container, this.env)
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
  async getMode(): Promise<{ mode: 'memory' | 'container' }> {
    return { mode: this.mode() }
  }

  async gitDiff(cwd?: string): Promise<{ diff: string }> {
    return { diff: await (await this.workspace()).gitDiff(cwd) }
  }

  async kill(execId?: string): Promise<{ ok: true }> {
    await (await this.workspace()).kill(execId)
    return { ok: true }
  }

  /**
   * HTTP entry for terminal WebSockets and container port previews.
   * Preview hosts look like `p3000-<folderId>.preview.example`.
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const preview = parsePreviewHost(url.hostname)

    if (preview) {
      const container = requireContainerMode(this.mode(), this.ctx.container)

      if (container instanceof Response) {
        return container
      }

      return proxyContainerPreview(request, container, preview.port)
    }

    if (url.pathname.includes('/sandbox/terminal')) {
      const container = requireContainerMode(this.mode(), this.ctx.container)

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

import { SandboxFileError } from '@cloudflare/sandbox'
import { DurableObject } from 'cloudflare:workers'

import type { ShuttleEnv } from '../env'
import { reapplyInactivityTimeout, requireContainerMode } from './container-runtime'
import { ContainerWorkspace } from './container-workspace'
import { MemoryWorkspace } from './memory-workspace'
import { parsePreviewHost } from './preview-host'
import { proxyContainerPreview } from './preview-proxy'
import { openContainerTerminal } from './terminal'
import type { ExecResult, LinkedSandboxRepo, Workspace, WorktreeResult } from './workspace'

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

  async ensureRepos(repos: LinkedSandboxRepo[]): Promise<{ root: string }> {
    const result = await (await this.workspace()).ensureRepos(repos)
    this.preparedRepos = true
    return result
  }

  async ensureWorktree(runId: string, threadId: string): Promise<WorktreeResult> {
    if (!this.preparedRepos) {
      await this.ensureRepos([])
    }

    return (await this.workspace()).ensureWorktree(runId, threadId)
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

  async exec(command: string, options?: { cwd?: string; timeoutMs?: number }): Promise<ExecResult> {
    return (await this.workspace()).exec(command, options)
  }

  /** Workspace mode for UI feature gates (terminal / browser). */
  async getMode(): Promise<{ mode: 'memory' | 'container' }> {
    return { mode: this.mode() }
  }

  async gitDiff(cwd?: string): Promise<{ diff: string }> {
    return { diff: await (await this.workspace()).gitDiff(cwd) }
  }

  async kill(pid?: number): Promise<{ ok: true }> {
    await (await this.workspace()).kill(pid)
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

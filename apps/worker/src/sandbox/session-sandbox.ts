import { Files } from '@cloudflare/sandbox'
import { DurableObject } from 'cloudflare:workers'

import type { ShuttleEnv } from '../env'
import { getInstallationToken } from '../github/app'
import { MemoryWorkspace } from './memory-workspace'
import {
  repoCheckoutPath,
  worktreeRepoPath,
  worktreeRoot,
  type ExecResult,
  type LinkedSandboxRepo,
  type Workspace,
  type WorktreeResult,
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
  private activePid: number | null = null
  private preparedRepos = false

  private mode(): 'memory' | 'container' {
    return this.env.SHUTTLE_WORKSPACE_MODE === 'container' ? 'container' : 'memory'
  }

  private async workspace(): Promise<Workspace> {
    if (this.mode() === 'memory') {
      this.memory ??= await MemoryWorkspace.restore(this.ctx.storage, this.env)
      this.memory.resetAbort()
      return this.memory
    }

    return this.containerWorkspace()
  }

  private containerWorkspace(): Workspace {
    const container = this.ctx.container

    if (!container) {
      throw new Error('SessionSandbox container binding is not configured')
    }

    const ensureStarted = async () => {
      if (!container.running) {
        container.start({
          image: 'cloudflare/sandbox:latest',
          entrypoint: ['sleep', 'infinity'],
          enableInternet: true,
        })
      }
    }

    const files = () => new Files(container)

    return {
      ensureRepos: async (repos) => {
        await ensureStarted()
        await files().mkdir('/workspace/repos', { recursive: true })

        if (repos.length === 0) {
          await files().writeFile('/workspace/repos/demo/README.md', '# Shuttle workspace\n')
          return { root: '/workspace' }
        }

        for (const repo of repos) {
          const target = repoCheckoutPath(repo.name)
          const token = await getInstallationToken(this.env, repo.installationId)
          const basic = btoa(`x-access-token:${token}`)
          const cloneUrl = `https://github.com/${repo.fullName}.git`

          const process = await container.exec([
            'bash',
            '-lc',
            [
              `if [ -d ${JSON.stringify(target)}/.git ]; then`,
              `  git -C ${JSON.stringify(target)} -c http.extraheader=${JSON.stringify(`AUTHORIZATION: basic ${basic}`)} fetch --depth 1 origin ${JSON.stringify(repo.defaultBranch)} &&`,
              `  git -C ${JSON.stringify(target)} checkout -B ${JSON.stringify(repo.defaultBranch)} FETCH_HEAD;`,
              `else`,
              `  mkdir -p /workspace/repos &&`,
              `  git -c http.extraheader=${JSON.stringify(`AUTHORIZATION: basic ${basic}`)} clone --depth 1 --branch ${JSON.stringify(repo.defaultBranch)} ${JSON.stringify(cloneUrl)} ${JSON.stringify(target)};`,
              `fi`,
            ].join(' '),
          ])

          await process.output()
        }

        return { root: '/workspace' }
      },
      ensureWorktree: async (runId, threadId) => {
        await ensureStarted()
        const root = worktreeRoot(runId, threadId)
        await files().mkdir(root, { recursive: true })

        const listed = await container
          .exec(['bash', '-lc', 'ls -1 /workspace/repos 2>/dev/null || true'])
          .then((process) => process.output())

        const names = new TextDecoder()
          .decode(listed.stdout)
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)

        const repoDirs: { name: string; root: string }[] = []

        for (const name of names) {
          const target = worktreeRepoPath(runId, threadId, name)
          repoDirs.push({ name, root: target })

          await container
            .exec([
              'bash',
              '-lc',
              [
                `mkdir -p ${JSON.stringify(root)} &&`,
                `(git -C ${JSON.stringify(repoCheckoutPath(name))} worktree add -B shuttle/${runId}/${threadId}/${name} ${JSON.stringify(target)} 2>/dev/null`,
                `|| cp -R ${JSON.stringify(repoCheckoutPath(name))}/. ${JSON.stringify(target)})`,
              ].join(' '),
            ])
            .then((process) => process.output())
        }

        return { root, repoDirs }
      },
      readFile: async (path, cwd) => {
        await ensureStarted()
        const response = await files().readFile(path, cwd ? { cwd } : undefined)
        return await response.text()
      },
      writeFile: async (path, content, cwd) => {
        await ensureStarted()
        await files().writeFile(path, content, cwd ? { cwd } : undefined)
      },
      editFile: async (path, oldText, newText, cwd) => {
        await ensureStarted()
        const response = await files().readFile(path, cwd ? { cwd } : undefined)
        const current = await response.text()

        if (!current.includes(oldText)) {
          throw new Error(`edit_file: old_text not found in ${path}`)
        }

        const replacements = current.split(oldText).length - 1

        await files().writeFile(
          path,
          current.split(oldText).join(newText),
          cwd ? { cwd } : undefined,
        )

        return replacements
      },
      grep: async (pattern, path, cwd) => {
        await ensureStarted()
        const target = path ?? '.'

        const process = await container.exec(
          [
            'bash',
            '-lc',
            `rg -n --no-heading ${JSON.stringify(pattern)} ${JSON.stringify(target)} || true`,
          ],
          cwd ? { cwd } : undefined,
        )

        const output = await process.output()
        return new TextDecoder().decode(output.stdout)
      },
      exec: async (command, options) => {
        await ensureStarted()

        const process = await container.exec(['bash', '-lc', command], {
          cwd: options?.cwd,
        })

        this.activePid = typeof process.pid === 'number' ? process.pid : null

        try {
          const output = await process.output()
          return {
            stdout: new TextDecoder().decode(output.stdout),
            stderr: new TextDecoder().decode(output.stderr ?? new Uint8Array()),
            exitCode: output.exitCode ?? 0,
          } satisfies ExecResult
        } finally {
          this.activePid = null
        }
      },
      gitDiff: async (cwd) => {
        await ensureStarted()
        const process = await container.exec(['git', 'diff'], cwd ? { cwd } : undefined)
        const output = await process.output()
        return new TextDecoder().decode(output.stdout)
      },
      kill: async (pid) => {
        const target = pid ?? this.activePid

        if (target == null) {
          return
        }

        await container.exec(['kill', '-TERM', String(target)]).then((process) => process.output())
      },
    }
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

  async readFile(path: string, cwd?: string): Promise<{ content: string }> {
    return { content: await (await this.workspace()).readFile(path, cwd) }
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

  async exec(command: string, options?: { cwd?: string; timeoutMs?: number }): Promise<ExecResult> {
    return (await this.workspace()).exec(command, options)
  }

  async gitDiff(cwd?: string): Promise<{ diff: string }> {
    return { diff: await (await this.workspace()).gitDiff(cwd) }
  }

  async kill(pid?: number): Promise<{ ok: true }> {
    await (await this.workspace()).kill(pid)
    return { ok: true }
  }
}

/** Preferred name; class remains SessionSandbox for the existing Durable Object binding. */
export { SessionSandbox as WorkspaceSandbox }

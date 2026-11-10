import { Files } from '@cloudflare/sandbox'
import { DurableObject } from 'cloudflare:workers'

import type { ShuttleEnv } from '../env'
import { MemoryWorkspace } from './memory-workspace'
import type { ExecResult, Workspace } from './workspace'

/**
 * One sandbox Durable Object per coding session (named by the Looms run id).
 *
 * Modes:
 * - `memory` (default): in-DO filesystem, no Docker required.
 * - `container`: real Linux via Durable Object containers + `@cloudflare/sandbox` Files.
 */
export class SessionSandbox extends DurableObject<ShuttleEnv> {
  private memory: MemoryWorkspace | null = null
  private activePid: number | null = null

  private mode(): 'memory' | 'container' {
    return this.env.SHUTTLE_WORKSPACE_MODE === 'container' ? 'container' : 'memory'
  }

  private async workspace(): Promise<Workspace> {
    if (this.mode() === 'memory') {
      this.memory ??= await MemoryWorkspace.restore(this.ctx.storage)
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
      ensureRepo: async (repoUrl) => {
        await ensureStarted()
        await files().mkdir('/workspace', { recursive: true })

        if (repoUrl) {
          const process = await container.exec([
            'git',
            'clone',
            '--depth',
            '1',
            repoUrl,
            '/workspace/repo',
          ])

          await process.output()
          return { root: '/workspace/repo' }
        }

        await files().writeFile('/workspace/README.md', '# Shuttle workspace\n')
        return { root: '/workspace' }
      },
      ensureWorktree: async (threadId) => {
        await ensureStarted()
        const root = `/workspace/.wt/${threadId}`

        await container
          .exec([
            'bash',
            '-lc',
            `mkdir -p ${root} && git worktree add ${root} -b wt-${threadId} 2>/dev/null || cp -R /workspace/repo/. ${root} 2>/dev/null || true`,
          ])
          .then((process) => process.output())

        return { root }
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

  async ensureRepo(repoUrl: string | null): Promise<{ root: string }> {
    return (await this.workspace()).ensureRepo(repoUrl)
  }

  async ensureWorktree(threadId: string): Promise<{ root: string }> {
    return (await this.workspace()).ensureWorktree(threadId)
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

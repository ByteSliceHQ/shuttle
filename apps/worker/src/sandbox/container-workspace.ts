import { Files } from '@cloudflare/sandbox'

import type { ShuttleEnv } from '../env'
import { getInstallationToken } from '../github/app'
import { ensureContainerRunning, type DurableContainer } from './container-runtime'
import { parentDirectory } from './paths'
import {
  repoCheckoutPath,
  resolvePath,
  worktreeRepoPath,
  worktreeRoot,
  type ExecResult,
  type LinkedSandboxRepo,
  type Workspace,
  type WorktreeResult,
} from './workspace'

/**
 * Real Linux workspace backed by a Durable Object container + `@cloudflare/sandbox` Files.
 */
export class ContainerWorkspace implements Workspace {
  private activePid: number | null = null

  constructor(
    private readonly getContainer: () => DurableContainer | undefined,
    private readonly env: ShuttleEnv,
  ) {}

  private async container(): Promise<DurableContainer> {
    return ensureContainerRunning(this.getContainer())
  }

  private files(container: DurableContainer): Files {
    return new Files(container)
  }

  async ensureRepos(repos: readonly LinkedSandboxRepo[]): Promise<{ root: string }> {
    const container = await this.container()
    const files = this.files(container)
    await files.mkdir('/workspace/repos', { recursive: true })

    if (repos.length === 0) {
      // Files.writeFile does not create parents; seed demo repo dirs first.
      await files.mkdir('/workspace/repos/demo', { recursive: true })
      await files.writeFile('/workspace/repos/demo/README.md', '# Shuttle workspace\n')
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
  }

  async ensureWorktree(runId: string, threadId: string): Promise<WorktreeResult> {
    const container = await this.container()
    const root = worktreeRoot(runId, threadId)
    await this.files(container).mkdir(root, { recursive: true })

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
  }

  async readFile(path: string, cwd?: string): Promise<string> {
    const container = await this.container()
    const response = await this.files(container).readFile(path, cwd ? { cwd } : undefined)
    return await response.text()
  }

  async writeFile(path: string, content: string, cwd?: string): Promise<void> {
    const container = await this.container()
    const files = this.files(container)
    const resolved = resolvePath(path, cwd)
    const parent = parentDirectory(resolved)

    // Match memory-workspace behavior: creating a file implies creating parents.
    if (parent) {
      await files.mkdir(parent, { recursive: true })
    }

    await files.writeFile(resolved, content)
  }

  async editFile(path: string, oldText: string, newText: string, cwd?: string): Promise<number> {
    const container = await this.container()
    const files = this.files(container)
    const resolved = resolvePath(path, cwd)
    const response = await files.readFile(resolved)
    const current = await response.text()

    if (!current.includes(oldText)) {
      throw new Error(`edit_file: old_text not found in ${resolved}`)
    }

    const replacements = current.split(oldText).length - 1
    const parent = parentDirectory(resolved)

    if (parent) {
      await files.mkdir(parent, { recursive: true })
    }

    await files.writeFile(resolved, current.split(oldText).join(newText))
    return replacements
  }

  async grep(pattern: string, path?: string, cwd?: string): Promise<string> {
    const container = await this.container()
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
  }

  async listFiles(root: string): Promise<string[]> {
    const container = await this.container()

    // Prefer find so listing does not depend on rg. Missing roots are empty,
    // not errors — container disk resets leave Events history without files.
    const script = [
      `root=${JSON.stringify(root)}`,
      `if [ ! -d "$root" ]; then`,
      `  exit 0`,
      `fi`,
      `find "$root" -type f`,
    ].join('\n')

    const process = await container.exec(['bash', '-lc', script])
    const output = await process.output()

    if ((output.exitCode ?? 0) !== 0) {
      const stderr = new TextDecoder().decode(output.stderr ?? new Uint8Array()).trim()
      throw new Error(stderr || `listFiles failed for ${root} (exit ${output.exitCode})`)
    }

    return new TextDecoder()
      .decode(output.stdout)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  }

  async exec(command: string, options?: { cwd?: string; timeoutMs?: number }): Promise<ExecResult> {
    const container = await this.container()

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
  }

  async gitDiff(cwd?: string): Promise<string> {
    const container = await this.container()
    const process = await container.exec(['git', 'diff'], cwd ? { cwd } : undefined)
    const output = await process.output()
    return new TextDecoder().decode(output.stdout)
  }

  async kill(pid?: number): Promise<void> {
    const target = pid ?? this.activePid

    if (target == null) {
      return
    }

    const container = await this.container()
    await container.exec(['kill', '-TERM', String(target)]).then((process) => process.output())
  }
}

import { Files } from '@cloudflare/sandbox'

import type { ShuttleEnv } from '../env'
import { getInstallationToken } from '../github/app'
import { ensureContainerRunning, type DurableContainer } from './container-runtime'
import { shellQuote, timedBashArgv } from './exec-argv'
import { parentDirectory } from './paths'
import {
  repoCheckoutPath,
  resolvePath,
  worktreeRepoPath,
  worktreeRoot,
  type ExecOptions,
  type ExecResult,
  type LinkedSandboxRepo,
  type Workspace,
  type WorktreeResult,
} from './workspace'

const DEFAULT_EXEC_TIMEOUT_MS = 120_000
const MAX_EXEC_TIMEOUT_MS = 600_000
const GREP_TIMEOUT_MS = 30_000
const OUTPUT_CAP_BYTES = 32 * 1024

/**
 * Real Linux workspace backed by a Durable Object container + `@cloudflare/sandbox` Files.
 */
export class ContainerWorkspace implements Workspace {
  /** One sandbox serves every worker in a session, so kills must target a specific exec. */
  private readonly activePids = new Map<string, number>()

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
      await this.seedDemoRepo(container, files)
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
          `if [ -d ${shellQuote(target)}/.git ]; then`,
          `  git -C ${shellQuote(target)} -c http.extraheader=${shellQuote(`AUTHORIZATION: basic ${basic}`)} fetch --depth 1 origin ${shellQuote(repo.defaultBranch)} &&`,
          `  git -C ${shellQuote(target)} checkout -B ${shellQuote(repo.defaultBranch)} FETCH_HEAD;`,
          `else`,
          `  mkdir -p /workspace/repos &&`,
          `  git -c http.extraheader=${shellQuote(`AUTHORIZATION: basic ${basic}`)} clone --depth 1 --branch ${shellQuote(repo.defaultBranch)} ${shellQuote(cloneUrl)} ${shellQuote(target)};`,
          `fi`,
        ].join(' '),
      ])

      await process.output()
    }

    return { root: '/workspace' }
  }

  async ensureWorktree(runId: string): Promise<WorktreeResult> {
    const container = await this.container()
    const root = worktreeRoot(runId)

    await this.execWithTimeout(
      `mkdir -p ${shellQuote(root)}`,
      { timeoutMs: GREP_TIMEOUT_MS },
      container,
    )

    const listed = await this.execWithTimeout(
      'ls -1 /workspace/repos 2>/dev/null || true',
      { timeoutMs: GREP_TIMEOUT_MS },
      container,
    )

    const names = listed.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)

    const repoDirs: { name: string; root: string }[] = []

    for (const name of names) {
      const target = worktreeRepoPath(runId, name)
      repoDirs.push({ name, root: target })
      const branch = `shuttle/${runId}/${name}`
      const source = repoCheckoutPath(name)

      // Shared per session: later workers must not clobber an existing worktree.
      await this.execWithTimeout(
        [
          `if [ ! -d ${shellQuote(target)} ]; then`,
          `  if [ -d ${shellQuote(source)}/.git ]; then`,
          `    git -C ${shellQuote(source)} worktree add -B ${shellQuote(branch)} ${shellQuote(target)};`,
          `  else`,
          `    mkdir -p ${shellQuote(root)} && cp -R ${shellQuote(source)}/. ${shellQuote(target)};`,
          `  fi`,
          `fi`,
        ].join(' '),
        { timeoutMs: GREP_TIMEOUT_MS },
        container,
      )
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
    const target = path ?? '.'

    const result = await this.exec(
      `rg -n --no-heading ${shellQuote(pattern)} ${shellQuote(target)} || true`,
      { cwd, timeoutMs: GREP_TIMEOUT_MS },
    )

    return result.stdout
  }

  async listFiles(root: string): Promise<string[]> {
    const script = [
      `root=${shellQuote(root)}`,
      `if [ ! -d "$root" ]; then`,
      `  exit 0`,
      `fi`,
      `find "$root" -type f`,
    ].join('\n')

    const result = await this.exec(script, { timeoutMs: GREP_TIMEOUT_MS })

    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.trim() || `listFiles failed for ${root} (exit ${result.exitCode})`,
      )
    }

    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  }

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    const container = await this.container()
    return this.execWithTimeout(command, options, container)
  }

  async gitDiff(cwd?: string): Promise<string> {
    const result = await this.exec('git diff', { cwd, timeoutMs: GREP_TIMEOUT_MS })
    return result.stdout
  }

  async kill(execId?: string): Promise<void> {
    const pid = execId ? this.activePids.get(execId) : undefined

    if (pid === undefined) {
      return
    }

    const container = await this.container()
    await container.exec(['kill', '-TERM', String(pid)]).then((process) => process.output())
  }

  private async seedDemoRepo(container: DurableContainer, files: Files): Promise<void> {
    await files.mkdir('/workspace/repos/demo', { recursive: true })
    await files.writeFile('/workspace/repos/demo/README.md', '# Shuttle workspace\n')

    await this.execWithTimeout(
      [
        'cd /workspace/repos/demo',
        'if [ ! -d .git ]; then',
        '  git init',
        '  git config user.email shuttle@local',
        '  git config user.name Shuttle',
        '  git add README.md',
        '  git commit -m "Initial commit"',
        'fi',
      ].join(' && '),
      { timeoutMs: GREP_TIMEOUT_MS },
      container,
    )
  }

  private async execWithTimeout(
    command: string,
    options: ExecOptions | undefined,
    container: DurableContainer,
  ): Promise<ExecResult> {
    const timeoutMs = Math.min(
      Math.max(1, options?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS),
      MAX_EXEC_TIMEOUT_MS,
    )

    const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000))
    const execId = options?.execId ?? crypto.randomUUID()

    const process = await container.exec(timedBashArgv(command, timeoutSeconds), {
      cwd: options?.cwd,
    })

    const pid = typeof process.pid === 'number' ? process.pid : undefined

    if (pid !== undefined) {
      this.activePids.set(execId, pid)
    }

    const raceKill = new Promise<ExecResult>((resolve) => {
      const timer = setTimeout(() => {
        if (pid !== undefined) {
          void container.exec(['kill', '-TERM', String(pid)]).then((proc) => proc.output())
        }

        resolve({
          stdout: '',
          stderr:
            `Command timed out after ${timeoutSeconds}s (exit 124). ` +
            'For long-running servers use: nohup <cmd> > log 2>&1 &\n',
          exitCode: 124,
        })
      }, timeoutMs + 5_000)

      process.output().then(
        (output) => {
          clearTimeout(timer)

          resolve({
            stdout: truncateOutput(new TextDecoder().decode(output.stdout)),
            stderr: truncateOutput(new TextDecoder().decode(output.stderr ?? new Uint8Array())),
            exitCode: output.exitCode ?? 0,
          })
        },
        (error: unknown) => {
          clearTimeout(timer)

          resolve({
            stdout: '',
            stderr: `${error instanceof Error ? error.message : String(error)}\n`,
            exitCode: 1,
          })
        },
      )
    })

    try {
      return await raceKill
    } finally {
      this.activePids.delete(execId)
    }
  }
}

function truncateOutput(text: string): string {
  if (text.length <= OUTPUT_CAP_BYTES) {
    return text
  }

  return `${text.slice(0, OUTPUT_CAP_BYTES)}\n...[truncated]\n`
}

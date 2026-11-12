import { Files } from '@cloudflare/sandbox'

import type { ShuttleEnv } from '../env'
import { getInstallationToken } from '../github/app'
import { ensureContainerRunning, type DurableContainer } from './container-runtime'
import { shellQuote, timedBashArgv } from './exec-argv'
import { parentDirectory } from './paths'
import { BASE_CONFIG_KEY, LAYER_CONFIG_KEY, PARENT_CONFIG_KEY } from './stack'
import { StackWorkspaceOps } from './stack-ops'
import {
  repoCheckoutPath,
  resolvePath,
  worktreeRepoPath,
  worktreeRoot,
  type ChangesetFile,
  type ChangesetResult,
  type CheckoutRefInput,
  type ExecOptions,
  type ExecResult,
  type LayerAddress,
  type LayerChangesetInput,
  type LinkedSandboxRepo,
  type NewLayerResult,
  type SealLayerResult,
  type StackStatus,
  type Workspace,
  type WorktreeResult,
} from './workspace'

const DEFAULT_EXEC_TIMEOUT_MS = 120_000
const MAX_EXEC_TIMEOUT_MS = 600_000
const GREP_TIMEOUT_MS = 30_000
const OUTPUT_CAP_BYTES = 32 * 1024

function recordBaseCommand(worktree: string, branch: string): string {
  const key = `branch.${branch}.${BASE_CONFIG_KEY}`
  return `git -C ${shellQuote(worktree)} config ${shellQuote(key)} "$(git -C ${shellQuote(worktree)} rev-parse HEAD)"`
}

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
          `    git -C ${shellQuote(source)} worktree add -B ${shellQuote(branch)} ${shellQuote(target)} &&`,
          `    ${recordBaseCommand(target, branch)} &&`,
          `    parent=$(git -C ${shellQuote(source)} symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || echo main) &&`,
          `    git -C ${shellQuote(target)} config ${shellQuote(`branch.${branch}.${LAYER_CONFIG_KEY}`)} 1 &&`,
          `    git -C ${shellQuote(target)} config ${shellQuote(`branch.${branch}.${PARENT_CONFIG_KEY}`)} "$parent";`,
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

  async changeset(runId: string, repoName: string, baseBranch?: string): Promise<ChangesetResult> {
    const cwd = worktreeRepoPath(runId, repoName)

    // The base must be a commit GitHub already has, so local agent commits stay in the
    // diff. Sessions record it at worktree creation; older ones fall back to merge-base.
    const fallbacks = baseBranch
      ? [`refs/remotes/origin/${baseBranch}`, `refs/heads/${baseBranch}`].map(
          (ref) => `git merge-base HEAD ${shellQuote(ref)} 2>/dev/null`,
        )
      : []

    const baseResult = await this.exec(
      [
        `git config --get "branch.$(git rev-parse --abbrev-ref HEAD).${BASE_CONFIG_KEY}"`,
        ...fallbacks,
        'git rev-parse HEAD',
      ].join(' || '),
      { cwd, timeoutMs: GREP_TIMEOUT_MS },
    )

    const baseSha = baseResult.stdout.trim().split('\n')[0] ?? ''

    if (baseResult.exitCode !== 0 || !baseSha) {
      throw new Error(baseResult.stderr.trim() || `Failed to resolve a base commit in ${cwd}`)
    }

    const [diff, untracked] = await Promise.all([
      this.exec(`git diff --name-status --no-renames -z ${shellQuote(baseSha)}`, {
        cwd,
        timeoutMs: GREP_TIMEOUT_MS,
      }),
      // Plain `git status` collapses a new directory to `dir/`; list every file instead.
      this.exec('git ls-files --others --exclude-standard -z', {
        cwd,
        timeoutMs: GREP_TIMEOUT_MS,
      }),
    ])

    if (diff.exitCode !== 0) {
      throw new Error(diff.stderr.trim() || `git diff failed in ${cwd}`)
    }

    if (untracked.exitCode !== 0) {
      throw new Error(untracked.stderr.trim() || `git ls-files failed in ${cwd}`)
    }

    const files: ChangesetFile[] = []
    const diffTokens = diff.stdout.split('\0').filter(Boolean)

    for (let index = 0; index + 1 < diffTokens.length; index += 2) {
      const code = diffTokens[index]!
      const path = diffTokens[index + 1]!

      if (code.startsWith('D')) {
        files.push({ path, status: 'deleted', content: null })
        continue
      }

      files.push({
        path,
        status: code.startsWith('A') ? 'added' : 'modified',
        content: await this.readFile(path, cwd),
      })
    }

    for (const path of untracked.stdout.split('\0').filter(Boolean)) {
      files.push({ path, status: 'added', content: await this.readFile(path, cwd) })
    }

    return { baseSha, files }
  }

  private stackOps(): StackWorkspaceOps {
    return new StackWorkspaceOps({
      exec: (command, options) => this.exec(command, options),
      ensureGitIdentity: (cwd) => this.ensureGitIdentity(cwd),
    })
  }

  async layerChangeset(
    runId: string,
    repoName: string,
    input: LayerChangesetInput,
  ): Promise<ChangesetResult> {
    return this.stackOps().layerChangeset(runId, repoName, input)
  }

  async stackStatus(runId: string, repoName: string, defaultBranch: string): Promise<StackStatus> {
    return this.stackOps().stackStatus(runId, repoName, defaultBranch)
  }

  async sealLayer(runId: string, repoName: string, message: string): Promise<SealLayerResult> {
    return this.stackOps().sealLayer(runId, repoName, message)
  }

  async newLayer(runId: string, repoName: string, defaultBranch: string): Promise<NewLayerResult> {
    return this.stackOps().newLayer(runId, repoName, defaultBranch)
  }

  async newStack(runId: string, repoName: string, defaultBranch: string): Promise<NewLayerResult> {
    return this.stackOps().newStack(runId, repoName, defaultBranch)
  }

  async checkoutLayer(
    runId: string,
    repoName: string,
    address: LayerAddress,
    defaultBranch: string,
  ): Promise<StackStatus> {
    return this.stackOps().checkoutLayer(runId, repoName, address, defaultBranch)
  }

  private async ensureGitIdentity(cwd: string): Promise<void> {
    await this.exec(
      ['git config user.email shuttle@local', 'git config user.name Shuttle'].join(' && '),
      { cwd, timeoutMs: GREP_TIMEOUT_MS },
    )
  }

  async checkoutRef(
    runId: string,
    repo: LinkedSandboxRepo,
    ref: CheckoutRefInput,
  ): Promise<{ root: string }> {
    const container = await this.container()
    const token = await getInstallationToken(this.env, repo.installationId)
    const basic = btoa(`x-access-token:${token}`)
    const source = repoCheckoutPath(repo.name)
    const target = worktreeRepoPath(runId, repo.name)
    const branch = ref.branch ?? `shuttle/${runId}/${repo.name}`

    await this.execWithTimeout(
      [
        `mkdir -p /workspace/repos /workspace/.wt/${shellQuote(runId)}`,
        `if [ ! -d ${shellQuote(source)}/.git ]; then`,
        `  git -c http.extraheader=${shellQuote(`AUTHORIZATION: basic ${basic}`)} clone --depth 1 ${shellQuote(`https://github.com/${repo.fullName}.git`)} ${shellQuote(source)};`,
        `fi`,
        `git -C ${shellQuote(source)} -c http.extraheader=${shellQuote(`AUTHORIZATION: basic ${basic}`)} fetch --depth 1 origin ${shellQuote(ref.sha)}`,
        `if [ -d ${shellQuote(target)} ]; then`,
        `  git -C ${shellQuote(source)} worktree remove --force ${shellQuote(target)} || rm -rf ${shellQuote(target)};`,
        `fi`,
        `git -C ${shellQuote(source)} worktree add -B ${shellQuote(branch)} ${shellQuote(target)} ${shellQuote(ref.sha)}`,
        recordBaseCommand(target, branch),
      ].join(' && '),
      { timeoutMs: DEFAULT_EXEC_TIMEOUT_MS },
      container,
    )

    return { root: target }
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

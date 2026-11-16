import type { ShuttleEnv } from '../env'
import { shellQuote, timedBashArgv } from './exec-argv'
import type { SandboxHost } from './host'
import { parentDirectory } from './paths'
import { repoAccess, repoUrls } from './repo-access'
import {
  BASE_CONFIG_KEY,
  LAYER_CONFIG_KEY,
  PARENT_CONFIG_KEY,
  REVIEW_BASE_CONFIG_KEY,
} from './stack'
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

/**
 * Records the commit a session branch started from. `--verify` makes an unborn HEAD fail here:
 * plain `rev-parse HEAD` prints the word "HEAD" in that case, which would be stored as the base.
 */
function recordBaseCommand(worktree: string, branch: string): string {
  const key = `branch.${branch}.${BASE_CONFIG_KEY}`
  return `base=$(git -C ${shellQuote(worktree)} rev-parse --verify HEAD) && git -C ${shellQuote(worktree)} config ${shellQuote(key)} "$base"`
}

/**
 * Shell that makes `target` the session's worktree of the repository cloned at `source`, on
 * `branch` at the commit `sha`, replacing any worktree already there. `baseSha` is fetched too
 * when given and recorded as what the branch's changes are measured from, so the session's
 * changes are the pull request's; failing to fetch it is not an error.
 */
export function checkoutRefScript(input: {
  readonly source: string
  readonly target: string
  readonly branch: string
  readonly cloneUrl: string
  readonly basicAuth: string
  readonly sha: string
  readonly baseSha?: string
}): string {
  const source = shellQuote(input.source)
  const target = shellQuote(input.target)
  const auth = `-c http.extraheader=${shellQuote(`Authorization: Basic ${input.basicAuth}`)}`
  const fetch = `git -C ${source} ${auth} fetch --depth 1 origin`

  return [
    `mkdir -p "$(dirname ${source})" "$(dirname ${target})"`,
    `if [ ! -d ${source}/.git ]; then git ${auth} clone --depth 1 ${shellQuote(input.cloneUrl)} ${source}; fi`,
    `${fetch} ${shellQuote(input.sha)}`,
    ...(input.baseSha ? [`{ ${fetch} ${shellQuote(input.baseSha)} || true; }`] : []),
    `if [ -d ${target} ]; then git -C ${source} worktree remove --force ${target} || rm -rf ${target}; fi`,
    `git -C ${source} worktree prune`,
    `git -C ${source} worktree add -B ${shellQuote(input.branch)} ${target} ${shellQuote(input.sha)}`,
    recordBaseCommand(input.target, input.branch),
    `parent=$(git -C ${source} symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')`,
    `{ [ -n "$parent" ] || parent=$(git -C ${source} rev-parse --abbrev-ref HEAD); }`,
    `git -C ${target} config ${shellQuote(`branch.${input.branch}.${LAYER_CONFIG_KEY}`)} 1`,
    `git -C ${target} config ${shellQuote(`branch.${input.branch}.${PARENT_CONFIG_KEY}`)} "$parent"`,
    // With the base here, what the session shows as changed is what the pull request changes.
    ...(input.baseSha
      ? [
          `if git -C ${target} cat-file -e ${shellQuote(`${input.baseSha}^{commit}`)} 2>/dev/null; then ${[
            REVIEW_BASE_CONFIG_KEY,
            BASE_CONFIG_KEY,
          ]
            .map(
              (key) =>
                `git -C ${target} config ${shellQuote(`branch.${input.branch}.${key}`)} ${shellQuote(input.baseSha ?? '')}`,
            )
            .join(' && ')}; fi`,
        ]
      : []),
  ].join(' && ')
}

/**
 * Shell that makes an existing checkout at `target` safe to fetch `cloneUrl` into.
 *
 * The same repository cloned from somewhere else (GitHub, before its Code Storage mirror existed)
 * stays where it is and is pointed at the new source: sessions have worktrees in it. A checkout
 * of some other repository under this name (the seeded demo repo, which has no origin) is moved
 * to `aside`, so the linked repository is the one sessions work in.
 */
export function settleOriginScript(input: {
  readonly target: string
  readonly cloneUrl: string
  /** Every URL this repository may have been cloned from. */
  readonly sameRepo: readonly string[]
  readonly aside: string
}): string {
  const target = shellQuote(input.target)
  const cloneUrl = shellQuote(input.cloneUrl)
  const parent = shellQuote(input.aside.slice(0, input.aside.lastIndexOf('/')))

  return [
    `origin=$(git -C ${target} config --get remote.origin.url 2>/dev/null || true);`,
    `if [ -d ${target}/.git ] && [ "$origin" != ${cloneUrl} ]; then`,
    `case "$origin" in`,
    `${input.sameRepo.map(shellQuote).join('|')}) git -C ${target} remote set-url origin ${cloneUrl};;`,
    `*) mkdir -p ${parent} && mv ${target} ${shellQuote(input.aside)}-$(date +%s);;`,
    `esac;`,
    `fi`,
  ].join(' ')
}

/**
 * Stops a command started by `timedBashArgv`. `kill` is run through bash because the sandbox
 * image has no `kill` program, only the shell's own. `timeout` leads a process group, so the
 * group is signalled: stopping only `timeout` would leave what it started running, holding the
 * command's output open.
 */
export function killArgv(pid: number): string[] {
  return ['bash', '-c', 'kill -TERM -- "-$1" 2>/dev/null || kill -TERM "$1"', 'bash', String(pid)]
}

/**
 * Real Linux workspace on a `SandboxHost`: a Durable Object container or a Daytona sandbox.
 */
export class ContainerWorkspace implements Workspace {
  /** One sandbox serves every worker in a session, so kills must target a specific exec. */
  private readonly activePids = new Map<string, number>()

  /** Commands under way, whether or not the host could report a pid for them. */
  private running = 0

  constructor(
    /** The host to run on, started if it has to be. Asked for on every operation. */
    private readonly host: () => Promise<SandboxHost>,
    private readonly env: ShuttleEnv,
    /** The organization this sandbox belongs to, when it belongs to one. */
    private readonly orgId: string | null = null,
  ) {}

  async ensureRepos(repos: readonly LinkedSandboxRepo[]): Promise<{ root: string }> {
    const host = await this.host()
    await host.mkdir('/workspace/repos')

    if (repos.length === 0) {
      await this.seedDemoRepo(host)
      return { root: '/workspace' }
    }

    for (const repo of repos) {
      const target = repoCheckoutPath(repo.name)
      const { url: cloneUrl, basicAuth: basic } = await repoAccess(this.env, repo, this.orgId)
      const sameRepo = repoUrls(this.env, repo, this.orgId)
      const cloning = `${target}.cloning`

      const process = await host.exec([
        'bash',
        '-lc',
        [
          `${settleOriginScript({ target, cloneUrl, sameRepo, aside: `/workspace/.replaced/${repo.name}` })};`,
          `if [ -d ${shellQuote(target)}/.git ]; then`,
          `  git -C ${shellQuote(target)} -c http.extraheader=${shellQuote(`Authorization: Basic ${basic}`)} fetch --depth 1 origin ${shellQuote(repo.defaultBranch)} &&`,
          `  git -C ${shellQuote(target)} checkout -B ${shellQuote(repo.defaultBranch)} FETCH_HEAD;`,
          `else`,
          // Clone beside the target and rename when done, so a `.git` directory at the target
          // always means a finished clone with a real HEAD.
          `  mkdir -p /workspace/repos && rm -rf ${shellQuote(cloning)} &&`,
          `  git -c http.extraheader=${shellQuote(`Authorization: Basic ${basic}`)} clone --depth 1 --branch ${shellQuote(repo.defaultBranch)} ${shellQuote(cloneUrl)} ${shellQuote(cloning)} &&`,
          `  rm -rf ${shellQuote(target)} && mv ${shellQuote(cloning)} ${shellQuote(target)};`,
          `fi`,
        ].join(' '),
      ])

      await process.output()
    }

    return { root: '/workspace' }
  }

  async ensureWorktree(runId: string): Promise<WorktreeResult> {
    const host = await this.host()
    const root = worktreeRoot(runId)

    await this.execWithTimeout(`mkdir -p ${shellQuote(root)}`, { timeoutMs: GREP_TIMEOUT_MS }, host)

    const listed = await this.execWithTimeout(
      'ls -1 /workspace/repos 2>/dev/null || true',
      { timeoutMs: GREP_TIMEOUT_MS },
      host,
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
      // The branch starts from an explicit commit. Without one, git cuts an empty orphan
      // branch when the source has no HEAD yet, and nothing built on it can become a PR.
      const created = await this.execWithTimeout(
        [
          `if [ ! -d ${shellQuote(target)} ]; then`,
          `  if [ -d ${shellQuote(source)}/.git ]; then`,
          `    start=$(git -C ${shellQuote(source)} rev-parse --verify 'HEAD^{commit}') &&`,
          `    git -C ${shellQuote(source)} worktree add -B ${shellQuote(branch)} ${shellQuote(target)} "$start" &&`,
          `    ${recordBaseCommand(target, branch)} &&`,
          `    parent=$(git -C ${shellQuote(source)} symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##') &&`,
          `    { [ -n "$parent" ] || parent=$(git -C ${shellQuote(source)} rev-parse --abbrev-ref HEAD); } &&`,
          `    git -C ${shellQuote(target)} config ${shellQuote(`branch.${branch}.${LAYER_CONFIG_KEY}`)} 1 &&`,
          `    git -C ${shellQuote(target)} config ${shellQuote(`branch.${branch}.${PARENT_CONFIG_KEY}`)} "$parent";`,
          `  else`,
          `    mkdir -p ${shellQuote(root)} && cp -R ${shellQuote(source)}/. ${shellQuote(target)};`,
          `  fi`,
          `fi`,
        ].join(' '),
        { timeoutMs: GREP_TIMEOUT_MS },
        host,
      )

      if (created.exitCode !== 0) {
        throw new Error(
          `Could not create the session worktree for ${name}: ${created.stderr.trim() || `exit ${created.exitCode}`}`,
        )
      }
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
    const host = await this.host()
    const { url: cloneUrl, basicAuth: basic } = await repoAccess(this.env, repo, this.orgId)
    const source = repoCheckoutPath(repo.name)
    const target = worktreeRepoPath(runId, repo.name)
    const branch = ref.branch ?? `shuttle/${runId}/${repo.name}`

    const checkedOut = await this.execWithTimeout(
      checkoutRefScript({
        source,
        target,
        branch,
        cloneUrl,
        basicAuth: basic,
        sha: ref.sha,
        ...(ref.baseSha ? { baseSha: ref.baseSha } : {}),
      }),
      { timeoutMs: DEFAULT_EXEC_TIMEOUT_MS },
      host,
    )

    if (checkedOut.exitCode !== 0) {
      throw new Error(
        `Could not check out ${ref.sha} of ${repo.name}: ${checkedOut.stderr.trim() || `exit ${checkedOut.exitCode}`}`,
      )
    }

    return { root: target }
  }

  async readFile(path: string, cwd?: string): Promise<string> {
    return (await this.host()).readFile(resolvePath(path, cwd))
  }

  async writeFile(path: string, content: string, cwd?: string): Promise<void> {
    const host = await this.host()
    const resolved = resolvePath(path, cwd)
    const parent = parentDirectory(resolved)

    // Match memory-workspace behavior: creating a file implies creating parents.
    if (parent) {
      await host.mkdir(parent)
    }

    await host.writeFile(resolved, content)
  }

  async readBytes(path: string, cwd?: string): Promise<Uint8Array> {
    return (await this.host()).readBytes(resolvePath(path, cwd))
  }

  async writeBytes(path: string, content: Uint8Array, cwd?: string): Promise<void> {
    const host = await this.host()
    const resolved = resolvePath(path, cwd)
    const parent = parentDirectory(resolved)

    if (parent) {
      await host.mkdir(parent)
    }

    await host.writeBytes(resolved, content)
  }

  async editFile(path: string, oldText: string, newText: string, cwd?: string): Promise<number> {
    const host = await this.host()
    const resolved = resolvePath(path, cwd)
    const current = await host.readFile(resolved)

    if (!current.includes(oldText)) {
      throw new Error(`edit_file: old_text not found in ${resolved}`)
    }

    const replacements = current.split(oldText).length - 1
    const parent = parentDirectory(resolved)

    if (parent) {
      await host.mkdir(parent)
    }

    await host.writeFile(resolved, current.split(oldText).join(newText))
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
    return this.execWithTimeout(command, options, await this.host())
  }

  async gitDiff(cwd?: string): Promise<string> {
    const result = await this.exec('git diff', { cwd, timeoutMs: GREP_TIMEOUT_MS })
    return result.stdout
  }

  busy(): boolean {
    return this.running > 0
  }

  async kill(execId?: string): Promise<void> {
    const pid = execId ? this.activePids.get(execId) : undefined

    if (pid === undefined) {
      return
    }

    const host = await this.host()
    await host.exec(killArgv(pid)).then((process) => process.output())
  }

  private async seedDemoRepo(host: SandboxHost): Promise<void> {
    // Only an empty sandbox gets the demo repo. Once any repository is checked out here,
    // seeding again would write over files in a linked repository that is also named "demo".
    const existing = await this.execWithTimeout(
      'ls -A /workspace/repos 2>/dev/null | head -1',
      { timeoutMs: GREP_TIMEOUT_MS },
      host,
    )

    if (existing.stdout.trim()) {
      return
    }

    await host.mkdir('/workspace/repos/demo')
    await host.writeFile('/workspace/repos/demo/README.md', '# Shuttle workspace\n')

    // One command per line: joining these with `&&` puts one straight after `then`, which the
    // shell rejects, and the demo directory is then left without a repository.
    const seeded = await this.execWithTimeout(
      [
        'set -e',
        'cd /workspace/repos/demo',
        'if [ ! -d .git ]; then',
        '  git init -q -b main',
        '  git config user.email shuttle@local',
        '  git config user.name Shuttle',
        '  git add README.md',
        '  git commit -q -m "Initial commit"',
        'fi',
      ].join('\n'),
      { timeoutMs: GREP_TIMEOUT_MS },
      host,
    )

    if (seeded.exitCode !== 0) {
      throw new Error(
        `Could not seed the demo repository: ${seeded.stderr.trim() || `exit ${seeded.exitCode}`}`,
      )
    }
  }

  private async execWithTimeout(
    command: string,
    options: ExecOptions | undefined,
    host: SandboxHost,
  ): Promise<ExecResult> {
    const timeoutMs = Math.min(
      Math.max(1, options?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS),
      MAX_EXEC_TIMEOUT_MS,
    )

    const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000))
    const execId = options?.execId ?? crypto.randomUUID()

    this.running++

    try {
      return await this.runTimed(command, options, host, timeoutMs, timeoutSeconds, execId)
    } finally {
      this.running--
    }
  }

  private async runTimed(
    command: string,
    options: ExecOptions | undefined,
    host: SandboxHost,
    timeoutMs: number,
    timeoutSeconds: number,
    execId: string,
  ): Promise<ExecResult> {
    const process = await host.exec(
      timedBashArgv(command, timeoutSeconds),
      options?.cwd ? { cwd: options.cwd } : {},
    )

    const { pid } = process

    if (pid !== undefined) {
      this.activePids.set(execId, pid)
    }

    const raceKill = new Promise<ExecResult>((resolve) => {
      const timer = setTimeout(() => {
        if (pid !== undefined) {
          void host.exec(killArgv(pid)).then((proc) => proc.output())
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
            stderr: truncateOutput(new TextDecoder().decode(output.stderr)),
            exitCode: output.exitCode,
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

import type { ShuttleEnv } from '../env'
import { fetchRepoTarball } from '../github/app'
import { parseTar, stripTarRoot } from './tar'
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

const FILE_PREFIX = 'file:'
const META_KEY = 'meta:repos'

/**
 * In-Durable-Object filesystem for demos without Docker.
 * Base checkouts live under `/workspace/repos/<name>`; worktrees are
 * copy-on-write overlays keyed by `/workspace/.wt/<runId>/<threadId>/<name>`.
 */
export class MemoryWorkspace implements Workspace {
  private readonly files = new Map<string, string | null>()
  private readonly dirty = new Set<string>()
  private repoNames: string[] = []
  private aborted = false
  private loaded = false

  constructor(
    private readonly storage?: DurableObjectStorage,
    private readonly env?: ShuttleEnv,
  ) {}

  async ensureRepos(repos: readonly LinkedSandboxRepo[]): Promise<{ root: string }> {
    await this.hydrate()

    if (repos.length === 0) {
      await this.seedDemoRepo()
      this.repoNames = ['demo']
      await this.persistMeta()
      await this.flush()
      return { root: '/workspace' }
    }

    for (const repo of repos) {
      const root = repoCheckoutPath(repo.name)
      const marker = `${root}/.shuttle-imported`

      if (this.files.has(marker) && this.files.get(marker) !== null) {
        continue
      }

      if (this.env) {
        await this.importTarball(repo)
      } else {
        this.files.set(`${root}/README.md`, `# ${repo.fullName}\n`)
        this.dirty.add(`${root}/README.md`)
      }

      this.files.set(marker, repo.fullName)
      this.dirty.add(marker)
    }

    this.repoNames = repos.map((repo) => repo.name)
    await this.persistMeta()
    await this.flush()
    return { root: '/workspace' }
  }

  async ensureWorktree(runId: string, threadId: string): Promise<WorktreeResult> {
    await this.hydrate()
    const root = worktreeRoot(runId, threadId)

    const repoDirs = this.repoNames.map((name) => ({
      name,
      root: worktreeRepoPath(runId, threadId, name),
    }))

    // Overlay markers so the worktree exists even before the first write.
    for (const dir of repoDirs) {
      const marker = `${dir.root}/.shuttle-worktree`

      if (!this.files.has(marker)) {
        this.files.set(marker, `${runId}/${threadId}`)
        this.dirty.add(marker)
      }
    }

    await this.flush()
    return { root, repoDirs }
  }

  async readFile(path: string, cwd?: string): Promise<string> {
    this.throwIfAborted()
    await this.hydrate()
    const resolved = resolvePath(path, cwd)
    const content = this.resolveOverlay(resolved)

    if (content === undefined) {
      throw new Error(`ENOENT: ${resolved}`)
    }

    return content
  }

  async writeFile(path: string, content: string, cwd?: string): Promise<void> {
    this.throwIfAborted()
    await this.hydrate()
    const resolved = resolvePath(path, cwd)
    this.files.set(resolved, content)
    this.dirty.add(resolved)
    await this.flush()
  }

  async editFile(path: string, oldText: string, newText: string, cwd?: string): Promise<number> {
    this.throwIfAborted()
    const current = await this.readFile(path, cwd)

    if (!current.includes(oldText)) {
      throw new Error(`edit_file: old_text not found in ${resolvePath(path, cwd)}`)
    }

    const next = current.split(oldText).join(newText)
    const replacements = current.split(oldText).length - 1
    await this.writeFile(path, next, cwd)
    return replacements
  }

  async grep(pattern: string, path?: string, cwd?: string): Promise<string> {
    this.throwIfAborted()
    await this.hydrate()
    const root = path ? resolvePath(path, cwd) : (cwd ?? '/workspace')
    const regex = new RegExp(pattern)
    const lines: string[] = []
    const seen = new Set<string>()

    for (const filePath of this.listVisiblePaths()) {
      if (!filePath.startsWith(root) || seen.has(filePath)) {
        continue
      }

      seen.add(filePath)
      const content = this.resolveOverlay(filePath)

      if (content == null) {
        continue
      }

      content.split('\n').forEach((line, index) => {
        if (regex.test(line)) {
          lines.push(`${filePath}:${index + 1}:${line}`)
        }
      })
    }

    return lines.join('\n')
  }

  async exec(command: string, options?: { cwd?: string; timeoutMs?: number }): Promise<ExecResult> {
    this.throwIfAborted()
    await this.hydrate()
    const cwd = options?.cwd ?? '/workspace'
    const trimmed = command.trim()

    if (trimmed === 'pwd') {
      return { stdout: `${cwd}\n`, stderr: '', exitCode: 0 }
    }

    if (trimmed === 'ls' || trimmed.startsWith('ls ')) {
      const target = trimmed === 'ls' ? cwd : resolvePath(trimmed.slice(3).trim(), cwd)
      const names = new Set<string>()

      for (const filePath of this.listVisiblePaths()) {
        if (
          !filePath.startsWith(target.endsWith('/') ? target : `${target}/`) &&
          filePath !== target
        ) {
          continue
        }

        const rest = filePath.slice(target.length).replace(/^\//, '')
        const name = rest.split('/')[0]

        if (name) {
          names.add(name)
        }
      }

      return {
        stdout: [...names].toSorted().join('\n') + (names.size ? '\n' : ''),
        stderr: '',
        exitCode: 0,
      }
    }

    if (trimmed.startsWith('cat ')) {
      try {
        const content = await this.readFile(trimmed.slice(4).trim(), cwd)
        return { stdout: content, stderr: '', exitCode: 0 }
      } catch (error) {
        return { stdout: '', stderr: String(error), exitCode: 1 }
      }
    }

    if (trimmed === 'git status' || trimmed.startsWith('git status ')) {
      return {
        stdout:
          'On branch main\nChanges not staged for commit:\n  (use memory workspace — commit not persisted)\n',
        stderr: '',
        exitCode: 0,
      }
    }

    if (trimmed === 'git diff' || trimmed.startsWith('git diff ')) {
      return { stdout: await this.gitDiff(cwd), stderr: '', exitCode: 0 }
    }

    return {
      stdout: '',
      stderr: `memory workspace: unsupported command: ${trimmed}\n`,
      exitCode: 127,
    }
  }

  async gitDiff(cwd?: string): Promise<string> {
    this.throwIfAborted()
    await this.hydrate()
    const root = cwd ?? '/workspace'
    const lines: string[] = []

    for (const filePath of this.listVisiblePaths().toSorted()) {
      if (!filePath.startsWith(root)) {
        continue
      }

      const current = this.resolveOverlay(filePath)
      const base = this.baseContent(filePath)

      if (current === base) {
        continue
      }

      if (base == null && current != null) {
        lines.push(`--- /dev/null`)
        lines.push(`+++ b${filePath}`)

        for (const line of current.split('\n')) {
          lines.push(`+${line}`)
        }

        continue
      }

      if (current == null && base != null) {
        lines.push(`--- a${filePath}`)
        lines.push(`+++ /dev/null`)

        for (const line of base.split('\n')) {
          lines.push(`-${line}`)
        }

        continue
      }

      if (current != null && base != null) {
        lines.push(`--- a${filePath}`)
        lines.push(`+++ b${filePath}`)

        for (const line of base.split('\n')) {
          lines.push(`-${line}`)
        }

        for (const line of current.split('\n')) {
          lines.push(`+${line}`)
        }
      }
    }

    return lines.join('\n')
  }

  async kill(): Promise<void> {
    this.aborted = true
  }

  resetAbort(): void {
    this.aborted = false
  }

  private throwIfAborted(): void {
    if (this.aborted) {
      throw new Error('Workspace operation aborted')
    }
  }

  private async seedDemoRepo(): Promise<void> {
    const root = repoCheckoutPath('demo')

    if (this.files.has(`${root}/README.md`)) {
      return
    }

    const seed: Record<string, string> = {
      [`${root}/README.md`]: '# Shuttle workspace\n\nRepo: local demo\n',
      [`${root}/package.json`]:
        JSON.stringify({ name: 'shuttle-demo-repo', version: '0.0.1', type: 'module' }, null, 2) +
        '\n',
      [`${root}/src/index.ts`]: `export function greet(name: string): string {\n  return \`Hello, \${name}!\`\n}\n`,
      [`${root}/src/math.ts`]: `export function add(a: number, b: number): number {\n  return a + b\n}\n`,
    }

    for (const [path, content] of Object.entries(seed)) {
      this.files.set(path, content)
      this.dirty.add(path)
    }
  }

  private async importTarball(repo: LinkedSandboxRepo): Promise<void> {
    if (!this.env) {
      return
    }

    const archive = await fetchRepoTarball(this.env, repo)
    const stream = new Blob([archive]).stream().pipeThrough(new DecompressionStream('gzip'))
    const gunzipped = await new Response(stream).arrayBuffer()
    const entries = parseTar(gunzipped)
    const root = repoCheckoutPath(repo.name)

    for (const entry of entries) {
      const relative = stripTarRoot(entry.path)

      if (!relative || relative.endsWith('/')) {
        continue
      }

      const path = `${root}/${relative}`
      this.files.set(path, entry.content)
      this.dirty.add(path)
    }
  }

  /** Resolve a path through worktree overlay → base checkout. */
  private resolveOverlay(path: string): string | undefined {
    if (this.files.has(path)) {
      const value = this.files.get(path)
      return value === null ? undefined : value
    }

    const base = this.basePathFor(path)

    if (base && this.files.has(base)) {
      const value = this.files.get(base)
      return value === null ? undefined : value
    }

    return undefined
  }

  private baseContent(path: string): string | undefined {
    const base = this.basePathFor(path) ?? path

    if (!this.files.has(base)) {
      return undefined
    }

    const value = this.files.get(base)
    return value === null ? undefined : value
  }

  private basePathFor(path: string): string | null {
    const match = path.match(/^\/workspace\/\.wt\/[^/]+\/[^/]+\/(.+)$/)

    if (!match?.[1]) {
      return null
    }

    return `/workspace/repos/${match[1]}`
  }

  private listVisiblePaths(): string[] {
    const paths = new Set<string>()

    for (const path of this.files.keys()) {
      if (this.files.get(path) === null) {
        continue
      }

      paths.add(path)

      // Synthesize overlay views of base files under each worktree.
      if (path.startsWith('/workspace/repos/')) {
        const relative = path.slice('/workspace/repos/'.length)

        for (const key of this.files.keys()) {
          const worktreeMatch = key.match(/^(\/workspace\/\.wt\/[^/]+\/[^/]+)\//)

          if (worktreeMatch?.[1]) {
            paths.add(`${worktreeMatch[1]}/${relative}`)
          }
        }
      }
    }

    return [...paths]
  }

  private async hydrate(): Promise<void> {
    if (this.loaded || !this.storage) {
      this.loaded = true
      return
    }

    const meta = await this.storage.get<string[]>(META_KEY)

    if (meta) {
      this.repoNames = meta
    }

    const listed = await this.storage.list<string>({ prefix: FILE_PREFIX })

    for (const [key, value] of listed) {
      this.files.set(key.slice(FILE_PREFIX.length), value)
    }

    this.loaded = true
  }

  private async persistMeta(): Promise<void> {
    if (!this.storage) {
      return
    }

    await this.storage.put(META_KEY, this.repoNames)
  }

  private async flush(): Promise<void> {
    if (!this.storage || this.dirty.size === 0) {
      return
    }

    const entries = [...this.dirty]
    this.dirty.clear()

    for (let index = 0; index < entries.length; index += 25) {
      const chunk = entries.slice(index, index + 25)
      const putBatch: Record<string, string> = {}
      const deleteKeys: string[] = []

      for (const path of chunk) {
        const value = this.files.get(path)

        if (value == null) {
          deleteKeys.push(`${FILE_PREFIX}${path}`)
        } else {
          putBatch[`${FILE_PREFIX}${path}`] = value
        }
      }

      if (Object.keys(putBatch).length > 0) {
        await this.storage.put(putBatch)
      }

      if (deleteKeys.length > 0) {
        await this.storage.delete(deleteKeys)
      }
    }
  }

  static async restore(storage: DurableObjectStorage, env?: ShuttleEnv): Promise<MemoryWorkspace> {
    return new MemoryWorkspace(storage, env)
  }
}

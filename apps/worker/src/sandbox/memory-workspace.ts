import { resolvePath, type ExecResult, type Workspace } from './workspace'

/**
 * In-Durable-Object filesystem for demos without Docker.
 * Enough for agents to read/write/edit files and run a few git-like commands.
 */
export class MemoryWorkspace implements Workspace {
  private readonly files = new Map<string, string>()
  private repoRoot = '/workspace'
  private aborted = false

  constructor(private readonly storage?: DurableObjectStorage) {}

  async ensureRepo(repoUrl: string | null): Promise<{ root: string }> {
    this.repoRoot = '/workspace'
    this.files.set('/workspace/README.md', `# Shuttle workspace\n\nRepo: ${repoUrl ?? 'local'}\n`)

    this.files.set(
      '/workspace/package.json',
      JSON.stringify({ name: 'shuttle-demo-repo', version: '0.0.1', type: 'module' }, null, 2) +
        '\n',
    )

    this.files.set(
      '/workspace/src/index.ts',
      `export function greet(name: string): string {\n  return \`Hello, \${name}!\`\n}\n`,
    )

    this.files.set(
      '/workspace/src/math.ts',
      `export function add(a: number, b: number): number {\n  return a + b\n}\n`,
    )

    await this.persist()
    return { root: this.repoRoot }
  }

  async ensureWorktree(threadId: string): Promise<{ root: string }> {
    const root = `/workspace/.wt/${threadId}`

    // Snapshot first: the loop adds worktree copies to the same map.
    const snapshot = Array.from(this.files)

    for (const [path, content] of snapshot) {
      if (!path.startsWith('/workspace/') || path.startsWith('/workspace/.wt/')) {
        continue
      }

      const relative = path.slice('/workspace/'.length)
      this.files.set(`${root}/${relative}`, content)
    }

    await this.persist()
    return { root }
  }

  async readFile(path: string, cwd?: string): Promise<string> {
    this.throwIfAborted()
    const resolved = resolvePath(path, cwd)
    const content = this.files.get(resolved)

    if (content === undefined) {
      throw new Error(`ENOENT: ${resolved}`)
    }

    return content
  }

  async writeFile(path: string, content: string, cwd?: string): Promise<void> {
    this.throwIfAborted()
    this.files.set(resolvePath(path, cwd), content)
    await this.persist()
  }

  async editFile(path: string, oldText: string, newText: string, cwd?: string): Promise<number> {
    this.throwIfAborted()
    const resolved = resolvePath(path, cwd)
    const current = this.files.get(resolved)

    if (current === undefined) {
      throw new Error(`ENOENT: ${resolved}`)
    }

    if (!current.includes(oldText)) {
      throw new Error(`edit_file: old_text not found in ${resolved}`)
    }

    const next = current.split(oldText).join(newText)
    const replacements = current.split(oldText).length - 1
    this.files.set(resolved, next)
    await this.persist()
    return replacements
  }

  async grep(pattern: string, path?: string, cwd?: string): Promise<string> {
    this.throwIfAborted()
    const root = path ? resolvePath(path, cwd) : (cwd ?? this.repoRoot)
    const regex = new RegExp(pattern)
    const lines: string[] = []

    for (const [filePath, content] of this.files) {
      if (!filePath.startsWith(root)) {
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
    const cwd = options?.cwd ?? this.repoRoot
    const trimmed = command.trim()

    if (trimmed === 'pwd') {
      return { stdout: `${cwd}\n`, stderr: '', exitCode: 0 }
    }

    if (trimmed === 'ls' || trimmed.startsWith('ls ')) {
      const target = trimmed === 'ls' ? cwd : resolvePath(trimmed.slice(3).trim(), cwd)
      const names = new Set<string>()

      for (const filePath of this.files.keys()) {
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
    const root = cwd ?? this.repoRoot
    const lines: string[] = []

    for (const [path, content] of [...this.files].toSorted(([a], [b]) => a.localeCompare(b))) {
      if (!path.startsWith(root)) {
        continue
      }

      lines.push(`--- a${path}`)
      lines.push(`+++ b${path}`)

      for (const line of content.split('\n')) {
        lines.push(`+${line}`)
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

  private async persist(): Promise<void> {
    if (!this.storage) {
      return
    }

    await this.storage.put(
      'files',
      Object.fromEntries(this.files.entries()) as Record<string, string>,
    )
  }

  static async restore(storage: DurableObjectStorage): Promise<MemoryWorkspace> {
    const workspace = new MemoryWorkspace(storage)
    const saved = await storage.get<Record<string, string>>('files')

    if (saved) {
      for (const [path, content] of Object.entries(saved)) {
        workspace.files.set(path, content)
      }
    }

    return workspace
  }
}

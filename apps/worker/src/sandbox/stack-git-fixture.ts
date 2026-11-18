import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { BASE_CONFIG_KEY } from './stack'
import { StackWorkspaceOps } from './stack-ops'
import { worktreeRepoPath, type ExecOptions, type ExecResult } from './workspace'

export interface StackGitFixture {
  readonly runId: string
  readonly repoName: string
  readonly baseSha: string
  readonly ops: StackWorkspaceOps
  /** Run a shell command in the session worktree; throws on failure. */
  readonly git: (command: string) => string
  readonly write: (path: string, content: string) => void
  readonly cleanup: () => void
}

/**
 * Real git repo laid out like a session worktree, with `/workspace` remapped to a
 * temp dir, so stack ops run the same commands they run in the container.
 */
export function createStackGitFixture(runId = 'session_1', repoName = 'glue'): StackGitFixture {
  const root = mkdtempSync(join(tmpdir(), 'shuttle-stack-'))
  const localPath = (path: string) => path.replace(/^\/workspace(?=\/|$)/, join(root, 'workspace'))
  const worktree = localPath(worktreeRepoPath(runId, repoName))
  mkdirSync(worktree, { recursive: true })

  const exec = (command: string, options?: ExecOptions): ExecResult => {
    const result = Bun.spawnSync(['bash', '-c', command], {
      cwd: localPath(options?.cwd ?? '/workspace'),
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: root },
    })

    return {
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      exitCode: result.exitCode,
    }
  }

  const git = (command: string) => {
    const result = exec(command, { cwd: worktreeRepoPath(runId, repoName) })

    if (result.exitCode !== 0) {
      throw new Error(`${command}\n${result.stderr !== '' ? result.stderr : result.stdout}`)
    }

    return result.stdout.trim()
  }

  const write = (path: string, content: string) => {
    const target = join(worktree, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }

  const branch = `shuttle/${runId}/${repoName}`
  git(`git init -q -b main && git config user.email t@t && git config user.name t`)
  write('README.md', 'base\n')
  git('git add -A && git commit -q -m base')
  const baseSha = git('git rev-parse HEAD')
  git(`git checkout -q -b ${branch} && git config branch.${branch}.${BASE_CONFIG_KEY} ${baseSha}`)

  const ops = new StackWorkspaceOps({
    exec: async (command, options) => exec(command, options),
    ensureGitIdentity: async () => {},
  })

  return {
    runId,
    repoName,
    baseSha,
    ops,
    git,
    write,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

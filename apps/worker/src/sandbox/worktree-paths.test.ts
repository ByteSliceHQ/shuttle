import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { worktreeRepoPath } from './workspace'
import { MAX_PATHS_PER_REPO, parseWorktreePaths, worktreePathsScript } from './worktree-paths'

const RUN = 'o-orgA-session_1'

/** A sandbox's /workspace in a temporary directory, as the workspace summary's tests make one. */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'shuttle-paths-'))
  const at = (path: string) => path.replace('/workspace', root)

  const sh = (script: string, cwd = '/workspace') => {
    const result = Bun.spawnSync(['bash', '-c', script.replaceAll('/workspace', root)], {
      cwd: at(cwd),
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    })

    return result.stdout.toString()
  }

  const write = (path: string, text: string) => {
    mkdirSync(join(at(path), '..'), { recursive: true })
    writeFileSync(at(path), text)
  }

  /** A shared checkout with one commit, and the session's worktree when `worktree` is set. */
  const repo = (name: string, worktree: boolean) => {
    const source = `/workspace/repos/${name}`

    write(`${source}/README.md`, '# start\n')
    write(`${source}/src/é.ts`, 'export {}\n')
    write(`${source}/.gitignore`, 'dist\n')

    sh(
      'git init -q -b main && git config user.email t@t && git config user.name t && git add -A && git commit -q -m start',
      source,
    )

    if (worktree) {
      sh(`git worktree add -q -b shuttle/${name} ${worktreeRepoPath(RUN, name)}`, source)
    }
  }

  return { root, sh, write, repo }
}

describe('worktree paths', () => {
  test('lists new files, drops ignored and deleted ones, and falls back to the checkout', () => {
    const box = sandbox()

    try {
      box.repo('web', true)
      box.repo('api', false)

      const web = worktreeRepoPath(RUN, 'web')
      box.write(`${web}/src/new.ts`, 'new\n')
      box.write(`${web}/dist/out.js`, 'built\n')
      box.write(`${web}/node_modules/x/index.js`, 'dep\n')
      box.sh(`rm ${web}/README.md`)

      const repos = parseWorktreePaths(box.sh(worktreePathsScript(RUN, ['web', 'api', 'gone'])))

      expect(repos).toEqual([
        { name: 'web', files: ['.gitignore', 'src/new.ts', 'src/é.ts'], truncated: false },
        { name: 'api', files: ['.gitignore', 'README.md', 'src/é.ts'], truncated: false },
      ])
    } finally {
      rmSync(box.root, { recursive: true, force: true })
    }
  })
})

describe('parseWorktreePaths', () => {
  test('cuts a repository off at the limit and says so', () => {
    const lines = [
      'REPO big',
      ...Array.from({ length: MAX_PATHS_PER_REPO + 1 }, (_, i) => `FILE f${i}`),
    ]

    const [big] = parseWorktreePaths(lines.join('\n'))

    expect(big?.files.length).toBe(MAX_PATHS_PER_REPO)
    expect(big?.truncated).toBe(true)
  })

  test('ignores lines before the first repository', () => {
    expect(parseWorktreePaths('FILE stray\nREPO a\nFILE x\n')).toEqual([
      { name: 'a', files: ['x'], truncated: false },
    ])
  })
})

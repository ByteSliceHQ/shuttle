import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseComparison } from '@shuttle/api'

import { insideSessionWorktree, sessionWorkDir, worktreeRepoPath } from './workspace'
import {
  adoptStrayScript,
  baseFileScript,
  fileDiffScript,
  isAdoptable,
  parseWorkspaceSummary,
  workspaceSummaryScript,
} from './workspace-summary'

const RUN = 'o-orgA-session_1'

/**
 * A sandbox's /workspace in a temporary directory. The scripts name absolute paths under
 * /workspace, which are pointed at it before they run.
 */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'shuttle-summary-'))
  const at = (path: string) => path.replace('/workspace', root)

  const sh = (script: string, cwd = root) => {
    const result = Bun.spawnSync(['bash', '-c', script.replaceAll('/workspace', root)], {
      cwd: at(cwd),
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    })

    return {
      stdout: result.stdout.toString().replaceAll(root, '/workspace'),
      stderr: result.stderr.toString(),
      exitCode: result.exitCode,
    }
  }

  /** A repository with one commit on main and the session's branch checked out in a worktree. */
  const repo = (name: string) => {
    const source = `/workspace/repos/${name}`
    const worktree = worktreeRepoPath(RUN, name)

    mkdirSync(at(source), { recursive: true })
    writeFileSync(join(at(source), 'README.md'), '# start\n')
    writeFileSync(join(at(source), 'old.txt'), 'old\n')
    writeFileSync(join(at(source), '.gitignore'), 'node_modules\n')

    sh(
      `git init -q -b main && git config user.email t@t && git config user.name t && git add -A && git commit -q -m start && git worktree add -q -b shuttle/${RUN}/${name} ${worktree}`,
      source,
    )

    return worktree
  }

  const write = (path: string, text: string) => {
    mkdirSync(join(at(path), '..'), { recursive: true })
    writeFileSync(at(path), text)
  }

  return { root, at, sh, repo, write }
}

describe('workspace summary', () => {
  const box = sandbox()
  const web = box.repo('web')
  const api = box.repo('api')

  // In web: a committed edit, an uncommitted new file, a deletion, and something ignored.
  box.write(`${web}/README.md`, '# start\nmore\n')
  box.sh('git commit -q -am "edit readme"', web)
  box.write(`${web}/src/todo.ts`, 'export {}\n')
  rmSync(box.at(`${web}/old.txt`))
  box.write(`${web}/node_modules/dep/index.js`, 'ignored\n')
  // In api, which has no ignore rule for it: installed dependencies are still not work.
  rmSync(box.at(`${api}/.gitignore`))
  box.sh('git commit -q -am "drop ignore file"', api)
  box.write(`${api}/node_modules/dep/index.js`, 'ignored\n')
  // Outside the worktree: what an agent left in the wrong place.
  box.write('/workspace/todo/index.html', '<h1>todo</h1>\n')
  box.write('/workspace/todo/app.js', '\n')

  const repos = [
    { name: 'web', defaultBranch: 'main' },
    { name: 'api', defaultBranch: 'main' },
  ]

  const summary = parseWorkspaceSummary(box.sh(workspaceSummaryScript(RUN, repos)).stdout)

  test('lists each repository with its files, leaving out what git ignores', () => {
    expect(summary.repos.map((repo) => repo.name)).toEqual(['web', 'api'])

    expect(summary.repos[0]?.files.toSorted()).toEqual(['.gitignore', 'README.md', 'src/todo.ts'])
    expect(summary.repos[1]?.files.toSorted()).toEqual(['README.md', 'old.txt'])
  })

  test('counts committed and uncommitted work, new files and deletions as changes', () => {
    expect(summary.repos[0]?.changes.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'old.txt', status: 'D' },
      { path: 'README.md', status: 'M' },
      { path: 'src/todo.ts', status: 'A' },
    ])

    expect(summary.repos[1]?.changes).toEqual([{ path: '.gitignore', status: 'D' }])
  })

  test('looking does not stage or commit anything', () => {
    expect(box.sh('git status --short', web).stdout.trimEnd().split('\n').toSorted()).toEqual([
      ' D old.txt',
      '?? src/',
    ])
  })

  test('reports what was written outside the worktree', () => {
    expect(summary.strays).toEqual([{ path: '/workspace/todo', files: 2 }])
  })

  test("one file's diff covers committed and new work", () => {
    const edited = box.sh(fileDiffScript('main', 'README.md'), web).stdout
    const added = box.sh(fileDiffScript('main', 'src/todo.ts'), web).stdout

    expect(edited).toContain('+more')
    expect(added).toContain('new file mode')
    expect(added).toContain('+export {}')
  })

  test('a file can be read as it was when the session started', () => {
    const before = box.sh(baseFileScript('main', 'README.md'), web)
    const added = box.sh(baseFileScript('main', 'src/todo.ts'), web)

    expect(before.stdout).toBe('# start\n')
    // It did not exist then.
    expect(added.exitCode).not.toBe(0)
  })

  test('a repository missing from the sandbox is left out, not an error', () => {
    const output = box.sh(workspaceSummaryScript(RUN, [{ name: 'gone', defaultBranch: 'main' }]))

    expect(output.exitCode).toBe(0)
    expect(parseWorkspaceSummary(output.stdout).repos).toEqual([])
  })

  test('moving a stray in puts it in the repository and refuses to overwrite', () => {
    expect(box.sh(adoptStrayScript('/workspace/todo', web)).exitCode).toBe(0)
    expect(readFileSync(box.at(`${web}/todo/index.html`), 'utf8')).toBe('<h1>todo</h1>\n')
    expect(existsSync(box.at('/workspace/todo'))).toBe(false)

    box.write('/workspace/todo/again.txt', 'x\n')

    const second = box.sh(adoptStrayScript('/workspace/todo', web))

    expect(second.exitCode).toBe(1)
    expect(second.stderr).toContain('already exists')
  })
})

describe('comparisons', () => {
  const box = sandbox()
  const web = box.repo('web')
  const source = '/workspace/repos/web'
  const sha = (ref: string, cwd = web) => box.sh(`git rev-parse ${ref}`, cwd).stdout.trim()

  // main moves on after the session starts, on a branch the session never sees otherwise.
  box.sh(
    'git checkout -q -b develop && echo d > develop.txt && git add -A && git commit -q -m develop && git checkout -q main',
    source,
  )

  const start = sha('HEAD')

  // Layer 1 commits a.txt; layer 2 commits b.txt; c.txt is not committed.
  box.write(`${web}/a.txt`, 'a\n')
  box.sh('git add -A && git commit -q -m "layer one"', web)
  const layer1 = `shuttle/${RUN}/web`
  box.sh(`git checkout -q -b shuttle/${RUN}-stack/web/2`, web)
  box.write(`${web}/b.txt`, 'b\n')
  box.sh('git add -A && git commit -q -m "layer two"', web)
  box.write(`${web}/c.txt`, 'c\n')

  const measure = (against: string) => {
    const [repo] = parseWorkspaceSummary(
      box.sh(workspaceSummaryScript(RUN, [{ name: 'web', defaultBranch: 'main', against }])).stdout,
    ).repos

    if (!repo?.measure || !repo.commits) {
      throw new Error('The repository was not measured')
    }

    return {
      ...repo,
      measure: repo.measure,
      commits: repo.commits,
      paths: repo.changes.map((change) => change.path).toSorted(),
    }
  }

  test('the session start counts every change, and the head, commits and dirt are reported', () => {
    const repo = measure('session')

    expect(repo.paths).toEqual(['a.txt', 'b.txt', 'c.txt'])
    expect(repo.sessionBaseSha).toBe(start)

    expect(repo.measure).toEqual({
      baseSha: start,
      baseMode: 'merge-base',
      headSha: null,
      error: null,
    })

    expect(repo.head).toEqual({
      branch: `shuttle/${RUN}-stack/web/2`,
      sha: sha('HEAD'),
      tree: sha('HEAD^{tree}'),
    })

    expect(repo.commits[0]?.tree).toBe(sha('HEAD^{tree}'))
    expect(repo.dirty).toBe(true)
    expect(repo.commits.map((commit) => commit.subject)).toEqual(['layer two', 'layer one'])
    expect(repo.commits[1]?.branches).toEqual([layer1])
    expect(repo.commits[0]?.at).toBeGreaterThan(0)
  })

  test('uncommitted counts only what is not committed', () => {
    expect(measure('uncommitted').paths).toEqual(['c.txt'])
  })

  test('a ref measures from where the work split from it, to the working tree', () => {
    expect(measure(`ref:${layer1}`).paths).toEqual(['b.txt', 'c.txt'])
    expect(measure('ref:develop').paths).toEqual(['a.txt', 'b.txt', 'c.txt'])
    expect(measure('ref:develop').measure.baseSha).toBe(start)
  })

  test('a range is what its head changes from its base, leaving out the working tree', () => {
    const top = measure(`range:${layer1}...shuttle/${RUN}-stack/web/2`)
    const bottom = measure(`range:main...${layer1}`)

    expect(top.paths).toEqual(['b.txt'])
    expect(top.measure.headSha).toBe(sha('HEAD'))
    expect(bottom.paths).toEqual(['a.txt'])

    expect(box.sh(fileDiffScript('main', 'a.txt', `range:main...${layer1}`), web).stdout).toContain(
      '+a',
    )

    expect(
      box.sh(baseFileScript('main', 'b.txt', `range:${layer1}...HEAD`, 'head'), web).stdout,
    ).toBe('b\n')

    expect(box.sh(baseFileScript('main', 'c.txt', 'session', 'head'), web).exitCode).not.toBe(0)
  })

  test('a reference that is not there is reported, with nothing counted', () => {
    const repo = measure('ref:nowhere')

    expect(repo.measure.error).toBe('missing')
    expect(repo.paths).toEqual([])
  })

  test('an unrelated history is measured from the reference itself', () => {
    box.sh(
      'git checkout -q --orphan island && git rm -rqf . && echo i > i.txt && git add -A && git commit -q -m island && git checkout -q main',
      source,
    )

    expect(measure('ref:island').measure.baseMode).toBe('tip')
  })
})

describe('reading comparisons', () => {
  test('only plain references are accepted', () => {
    expect(parseComparison('session')).toEqual({ kind: 'session' })
    expect(parseComparison('ref:release/2026.11')).toEqual({ kind: 'ref', ref: 'release/2026.11' })

    expect(parseComparison('range:main...shuttle/a/web')).toEqual({
      kind: 'range',
      base: 'main',
      head: 'shuttle/a/web',
    })

    for (const bad of [
      'ref:',
      'ref:-x',
      'ref:a..b',
      'ref:a b',
      "ref:a'b",
      'ref:a;rm',
      'range:a',
      'range:a...b...c',
      'ref:/etc',
      'ref:a.lock',
      'nope',
    ]) {
      expect(parseComparison(bad)).toBeNull()
    }
  })
})

describe('where work may go', () => {
  test("only things directly under /workspace that are not Shuttle's can be moved in", () => {
    expect(isAdoptable('/workspace/todo')).toBe(true)
    expect(isAdoptable('/workspace/repos')).toBe(false)
    expect(isAdoptable('/workspace/.wt')).toBe(false)
    expect(isAdoptable('/workspace/a/b')).toBe(false)
    expect(isAdoptable('/etc/passwd')).toBe(false)
  })

  test('a path is inside the worktree only when it resolves there', () => {
    const cwd = worktreeRepoPath(RUN, 'demo')

    expect(insideSessionWorktree(RUN, 'src/app.ts', cwd)).toBe(true)
    expect(insideSessionWorktree(RUN, `${cwd}/src/app.ts`)).toBe(true)
    expect(insideSessionWorktree(RUN, '/workspace/todo/index.html', cwd)).toBe(false)
    expect(insideSessionWorktree(RUN, '../../../todo/index.html', cwd)).toBe(false)
    expect(insideSessionWorktree(RUN, '/workspace/.wt/o-orgA-session_10/demo/a.ts')).toBe(false)
  })

  test('agents start in the repository, or beside the repositories when there are several', () => {
    expect(sessionWorkDir(RUN, [])).toBe(`/workspace/.wt/${RUN}/demo`)
    expect(sessionWorkDir(RUN, [{ name: 'web' }])).toBe(`/workspace/.wt/${RUN}/web`)
    expect(sessionWorkDir(RUN, [{ name: 'web' }, { name: 'api' }])).toBe(`/workspace/.wt/${RUN}`)
  })
})

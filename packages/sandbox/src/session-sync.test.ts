import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  parseSnapshot,
  restoreSession,
  remoteBranchRef,
  sessionRemoteRefs,
  snapshotSession,
  type SyncHost,
} from './session-sync'
import { repoCheckoutPath, worktreeRepoPath, type ExecOptions } from './workspace'

const RUN = 'o-orgA-session_1'
const REPO = 'glue'
const BRANCH = `shuttle/${RUN}/${REPO}`
const LAYER_2 = `shuttle/${RUN}-stack/${REPO}/2`

const roots: string[] = []

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempDir(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `shuttle-sync-${label}-`))
  roots.push(root)

  return root
}

/** A bare repository with one commit on main, standing in for Code Storage. */
function createRemote(): string {
  const root = tempDir('remote')
  const seed = join(root, 'seed')
  const bare = join(root, 'remote.git')

  const sh = (command: string, cwd: string) => {
    const result = Bun.spawnSync(['bash', '-c', command], {
      cwd,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: root },
    })

    if (result.exitCode !== 0) {
      throw new Error(`${command}\n${result.stderr.toString()}`)
    }
  }

  mkdirSync(seed, { recursive: true })
  writeFileSync(join(seed, 'README.md'), 'base\n')
  writeFileSync(join(seed, 'old.txt'), 'to be deleted\n')
  writeFileSync(join(seed, '.gitignore'), 'node_modules/\n')

  sh(
    'git init -q -b main && git config user.email t@t && git config user.name t && git add -A && git commit -q -m base',
    seed,
  )

  sh(`git clone -q --bare ${seed} ${bare}`, root)

  return bare
}

/** A sandbox: its own disk, with `/workspace` remapped to a temp dir, and the repo cloned. */
function createSandbox(label: string, remote: string) {
  const root = tempDir(label)
  const local = (path: string) => path.replace(/^\/workspace(?=\/|$)/, join(root, 'workspace'))

  const sh = (command: string, cwd = '/workspace') => {
    mkdirSync(local(cwd), { recursive: true })

    // The scripts name /workspace paths directly, so they are remapped here too.
    const result = Bun.spawnSync(
      ['bash', '-c', command.replaceAll('/workspace', local('/workspace'))],
      {
        cwd: local(cwd),
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: root },
      },
    )

    return {
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      exitCode: result.exitCode,
    }
  }

  const host: SyncHost = {
    exec: async (command, options?: ExecOptions) => sh(command, options?.cwd),
  }

  const worktree = worktreeRepoPath(RUN, REPO)

  const git = (command: string) => {
    const result = sh(command, worktree)

    if (result.exitCode !== 0) {
      throw new Error(`${command}\n${result.stderr || result.stdout}`)
    }

    return result.stdout.trim()
  }

  const clone = sh(
    `git clone -q ${remote} ${repoCheckoutPath(REPO)} && git -C ${repoCheckoutPath(REPO)} config user.email t@t && git -C ${repoCheckoutPath(REPO)} config user.name t`,
  )

  if (clone.exitCode !== 0) {
    throw new Error(clone.stderr)
  }

  return {
    host,
    git,
    sh,
    path: (file: string) => join(local(worktree), file),
    write: (file: string, content: string) => {
      const target = join(local(worktree), file)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content)
    },
  }
}

/** What a person would see in the worktree: branch, commit, and the state of every file. */
function describeWorktree(sandbox: ReturnType<typeof createSandbox>) {
  return {
    branch: sandbox.git('git symbolic-ref --short HEAD'),
    head: sandbox.git('git rev-parse HEAD'),
    status: sandbox.git('git status --porcelain --untracked-files=all'),
    branches: sandbox.git(
      `git for-each-ref --format='%(refname:short) %(objectname)' refs/heads/shuttle/`,
    ),
    config: sandbox.git(String.raw`git config --get-regexp '^branch\.shuttle/' | sort`),
  }
}

/** The paths a `git status --porcelain` listing names, whatever state each is in. */
function changedPaths(status: string): string[] {
  return status
    .split('\n')
    .map((entry) => entry.slice(3))
    .toSorted()
}

describe('moving a session between sandboxes', () => {
  const remote = createRemote()
  const access = { url: remote, basicAuth: 'unused-by-a-local-remote' }
  const alice = createSandbox('alice', remote)
  const bob = createSandbox('bob', remote)

  // Alice's session: two stack layers with their config, then work in progress on the second.
  alice.sh(
    `git -C ${repoCheckoutPath(REPO)} worktree add -q -B ${BRANCH} ${worktreeRepoPath(RUN, REPO)} HEAD`,
  )

  alice.git(
    `git config branch.${BRANCH}.shuttleBase "$(git rev-parse HEAD)" && git config branch.${BRANCH}.shuttleLayer 1 && git config branch.${BRANCH}.shuttleParent main`,
  )

  alice.write('src/app.ts', 'export const layer = 1\n')
  alice.git('git add -A && git commit -q -m "layer one"')

  alice.git(
    `git checkout -q -b ${LAYER_2} && git config branch.${LAYER_2}.shuttleLayer 2 && git config branch.${LAYER_2}.shuttleParent ${BRANCH}`,
  )

  alice.write('src/app.ts', 'export const layer = 2\n')
  alice.git('git add -A && git commit -q -m "layer two"')
  // Some other session's branch in the same clone must not travel with this one.
  alice.git('git branch shuttle/o-orgA-session_other/glue')

  // Uncommitted: an edit, a staged new file, an untracked file, a deletion, and an ignored file.
  alice.write('src/app.ts', 'export const layer = 2\nexport const wip = true\n')
  alice.write('staged.txt', 'staged\n')
  alice.git('git add staged.txt')
  alice.write('notes/untracked.md', 'untracked\n')
  alice.git('rm old.txt')
  alice.write('node_modules/dep/index.js', 'ignored\n')

  const before = describeWorktree(alice)
  let snapshot: Awaited<ReturnType<typeof snapshotSession>>

  test('a snapshot records the branches and leaves the worktree exactly as it was', async () => {
    snapshot = await snapshotSession(alice.host, RUN, REPO, access)

    expect(snapshot.head).toBe(LAYER_2)
    expect(snapshot.headSha).toBe(before.head)
    expect(snapshot.snapshotSha).not.toBe(before.head)

    expect(snapshot.branches.map((branch) => branch.name).toSorted()).toEqual(
      [BRANCH, LAYER_2].toSorted(),
    )

    expect(snapshot.config.map(({ key }) => key).toSorted()).toEqual(
      [
        `branch.${BRANCH}.shuttlebase`,
        `branch.${BRANCH}.shuttlelayer`,
        `branch.${BRANCH}.shuttleparent`,
        `branch.${LAYER_2}.shuttlelayer`,
        `branch.${LAYER_2}.shuttleparent`,
      ].toSorted(),
    )

    // Taking it changed nothing Alice can see, staged or not.
    expect(describeWorktree(alice)).toEqual(before)
    expect(alice.git('git diff --cached --name-only')).toBe('staged.txt')
  })

  test('the snapshot is pushed only under the session', async () => {
    const refs = Bun.spawnSync(['git', 'ls-remote', remote]).stdout.toString()
    const { work, branches } = sessionRemoteRefs(RUN, REPO)

    expect(refs).toContain(work)
    expect(refs).toContain(remoteBranchRef(RUN, REPO, BRANCH))
    expect(refs).toContain(remoteBranchRef(RUN, REPO, LAYER_2))
    // The run id appears once in a remote name, which keeps it short enough for Code Storage.
    expect(remoteBranchRef(RUN, REPO, BRANCH)).toBe(`${branches}s/${REPO}`)
    expect(refs).not.toContain('session_other')
    // The normal branch is untouched.
    expect(refs.split('\n').filter((line) => line.endsWith('refs/heads/main'))).toHaveLength(1)
  })

  test('restoring it in another sandbox rebuilds the same worktree', async () => {
    await restoreSession(bob.host, RUN, access, snapshot)

    const restored = describeWorktree(bob)

    expect(restored.branch).toBe(before.branch)
    expect(restored.head).toBe(before.head)
    expect(restored.config).toBe(before.config)

    expect(restored.branches).toBe(
      before.branches
        .split('\n')
        .filter((line) => !line.includes('session_other'))
        .join('\n'),
    )

    // Same files changed, added and deleted. What Alice had staged is plain uncommitted here.

    expect(changedPaths(restored.status)).toEqual(changedPaths(before.status))

    expect(readFileSync(bob.path('src/app.ts'), 'utf8')).toBe(
      'export const layer = 2\nexport const wip = true\n',
    )

    expect(readFileSync(bob.path('notes/untracked.md'), 'utf8')).toBe('untracked\n')
    expect(readFileSync(bob.path('staged.txt'), 'utf8')).toBe('staged\n')
    expect(existsSync(bob.path('old.txt'))).toBe(false)
    // Dependencies are not carried.
    expect(existsSync(bob.path('node_modules'))).toBe(false)
    // Nothing was committed to make this happen.
    expect(bob.git('git log --oneline').split('\n')).toHaveLength(3)
  })

  test('work goes back to the first sandbox, replacing what it had left', async () => {
    bob.write('src/app.ts', 'export const layer = 2\nexport const wip = "bob"\n')
    bob.git('git add -A && git commit -q -m "bob finishes layer two"')
    bob.write('notes/untracked.md', 'bob edited\n')

    const fromBob = await snapshotSession(bob.host, RUN, REPO, access)

    // Alice's sandbox still has her old worktree, with a stray file she never snapshotted.
    alice.write('stray.txt', 'left behind\n')

    await restoreSession(alice.host, RUN, access, fromBob)

    expect(alice.git('git rev-parse HEAD')).toBe(bob.git('git rev-parse HEAD'))
    expect(readFileSync(alice.path('notes/untracked.md'), 'utf8')).toBe('bob edited\n')
    expect(existsSync(alice.path('stray.txt'))).toBe(false)
    expect(describeWorktree(alice).status).toBe(describeWorktree(bob).status)
  })
})

describe('parseSnapshot', () => {
  test('reads each record and keeps config values with spaces', () => {
    expect(
      parseSnapshot(
        'glue',
        'HEAD shuttle/r/glue\nHEADSHA aaa\nSNAPSHOT bbb\nBRANCH aaa shuttle/r/glue\nCONFIG branch.shuttle/r/glue.shuttleparent a b\n',
      ),
    ).toEqual({
      repoName: 'glue',
      head: 'shuttle/r/glue',
      headSha: 'aaa',
      snapshotSha: 'bbb',
      branches: [{ name: 'shuttle/r/glue', sha: 'aaa' }],
      config: [{ key: 'branch.shuttle/r/glue.shuttleparent', value: 'a b' }],
    })
  })

  test('a worktree that reported nothing is an error', () => {
    expect(() => parseSnapshot('glue', '')).toThrow('reported no branch')
  })
})

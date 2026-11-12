import { describe, expect, test } from 'bun:test'

import { MemoryWorkspace } from './memory-workspace'

describe('memory workspace overlays', () => {
  test('copy-on-write worktrees diff against the base checkout', async () => {
    const workspace = new MemoryWorkspace()
    await workspace.ensureRepos([])
    const worktree = await workspace.ensureWorktree('run_1')
    const cwd = worktree.repoDirs[0]!.root
    expect(cwd).toBe('/workspace/.wt/run_1/demo')

    const before = await workspace.readFile('src/math.ts', cwd)
    expect(before).toContain('export function add')

    await workspace.editFile('src/math.ts', 'return a + b', 'return a + b + 0', cwd)

    const diff = await workspace.gitDiff(cwd)
    expect(diff).toContain('src/math.ts')
    expect(diff).toContain('return a + b + 0')
    expect(diff).toContain('-  return a + b')

    // A second ensureWorktree for the same run reuses the shared overlay.
    const again = await workspace.ensureWorktree('run_1')
    expect(again.repoDirs[0]!.root).toBe(cwd)
    const shared = await workspace.readFile('src/math.ts', again.repoDirs[0]!.root)
    expect(shared).toContain('a + b + 0')

    // Base checkout remains unchanged.
    const base = await workspace.readFile('/workspace/repos/demo/src/math.ts')
    expect(base).toContain('return a + b\n')
    expect(base).not.toContain('a + b + 0')

    const changeset = await workspace.changeset('run_1', 'demo')
    expect(changeset.baseSha).toBe('memory-demo-base')
    expect(changeset.files.some((file) => file.path === 'src/math.ts')).toBe(true)
    expect(changeset.files.find((file) => file.path === 'src/math.ts')?.status).toBe('modified')

    expect(changeset.files.find((file) => file.path === 'src/math.ts')?.content).toContain(
      'a + b + 0',
    )
  })
})

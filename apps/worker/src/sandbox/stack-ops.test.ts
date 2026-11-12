import { afterEach, describe, expect, test } from 'bun:test'

import { createStackGitFixture, type StackGitFixture } from './stack-git-fixture'

describe('StackWorkspaceOps against a real git worktree', () => {
  let fixture: StackGitFixture | null = null

  afterEach(() => {
    fixture?.cleanup()
    fixture = null
  })

  const setup = () => {
    fixture = createStackGitFixture()
    const { ops, runId, repoName } = fixture

    return {
      ...fixture,
      status: () => ops.stackStatus(runId, repoName, 'main'),
      files: () => fixture!.git('git ls-files').split('\n').toSorted(),
    }
  }

  test('a fresh session is stack 1 layer 1 with pending edits', async () => {
    const { write, status, baseSha } = setup()
    write('a.txt', 'a\n')

    const result = await status()

    expect(result.currentStack).toBe(1)
    expect(result.currentLayer).toBe(1)
    expect(result.stacks).toHaveLength(1)
    expect(result.stacks[0]!.baseSha).toBe(baseSha)
    expect(result.layers[0]!.pending).toBe(true)
    expect(result.layers[0]!.files).toEqual(['a.txt'])
  })

  test('new_stack starts a standalone stack off the session base, not the current stack', async () => {
    const { ops, runId, repoName, write, git, status, files, baseSha } = setup()

    write('a.txt', 'a\n')
    await ops.newLayer(runId, repoName, 'main')
    write('b.txt', 'b\n')

    const created = await ops.newStack(runId, repoName, 'main')

    expect(created).toMatchObject({
      stack: 2,
      layer: 1,
      branch: 'shuttle/session_1-stack2/glue/1',
      parentBranch: 'main',
    })

    expect(git('git rev-parse HEAD')).toBe(baseSha)
    expect(files()).toEqual(['README.md'])

    write('c.txt', 'c\n')
    const result = await status()

    expect(result.currentStack).toBe(2)
    expect(result.currentLayer).toBe(1)
    expect(result.layers.map((layer) => layer.branch)).toEqual(['shuttle/session_1-stack2/glue/1'])

    expect(
      result.stacks.map((stack) => ({
        stack: stack.stack,
        baseSha: stack.baseSha,
        layers: stack.layers.map((layer) => [layer.layer, layer.files]),
      })),
    ).toEqual([
      {
        stack: 1,
        baseSha,
        layers: [
          [1, ['a.txt']],
          [2, ['b.txt']],
        ],
      },
      { stack: 2, baseSha, layers: [[1, ['c.txt']]] },
    ])
  })

  test('layer changesets diff a standalone stack against the base only', async () => {
    const { ops, runId, repoName, write, baseSha } = setup()

    write('a.txt', 'a\n')
    await ops.newStack(runId, repoName, 'main')
    write('c.txt', 'c\n')
    await ops.sealLayer(runId, repoName, 'standalone')

    const changeset = await ops.layerChangeset(runId, repoName, {
      parentRef: baseSha,
      layerRef: 'shuttle/session_1-stack2/glue/1',
    })

    expect(changeset.baseSha).toBe(baseSha)
    expect(changeset.files).toEqual([{ path: 'c.txt', status: 'added', content: 'c\n' }])
  })

  test('layer changesets reject parents that only exist on GitHub', async () => {
    const { ops, runId, repoName } = setup()

    await expect(
      ops.layerChangeset(runId, repoName, {
        parentRef: 'deadbeef'.repeat(5),
        layerRef: 'shuttle/session_1/glue',
      }),
    ).rejects.toThrow('Failed to resolve parent')
  })

  test('editing a lower layer restacks only its own stack and keeps HEAD in place', async () => {
    const { ops, runId, repoName, write, git } = setup()

    write('a.txt', 'a\n')
    await ops.newLayer(runId, repoName, 'main')
    write('b.txt', 'b\n')
    await ops.newStack(runId, repoName, 'main')
    write('c.txt', 'c\n')
    await ops.sealLayer(runId, repoName, 'standalone')
    const standaloneTip = git('git rev-parse shuttle/session_1-stack2/glue/1')

    await ops.checkoutLayer(runId, repoName, { stack: 1, layer: 1 }, 'main')
    write('a.txt', 'a fixed\n')
    const sealed = await ops.sealLayer(runId, repoName, 'fix a')

    expect(sealed.sealed).toBe(true)
    expect(git('git rev-parse --abbrev-ref HEAD')).toBe('shuttle/session_1/glue')

    expect(git('git merge-base shuttle/session_1/glue shuttle/session_1-stack/glue/2')).toBe(
      sealed.tipSha,
    )

    expect(git('git show shuttle/session_1-stack/glue/2:a.txt')).toBe('a fixed')
    expect(git('git show shuttle/session_1-stack/glue/2:b.txt')).toBe('b')
    expect(git('git rev-parse shuttle/session_1-stack2/glue/1')).toBe(standaloneTip)
  })

  test('checkout switches between stacks and seals pending edits first', async () => {
    const { ops, runId, repoName, write, files } = setup()

    write('a.txt', 'a\n')
    await ops.newStack(runId, repoName, 'main')
    write('c.txt', 'c\n')

    const onStack1 = await ops.checkoutLayer(runId, repoName, { stack: 1, layer: 1 }, 'main')

    expect(onStack1.currentStack).toBe(1)
    expect(files()).toEqual(['README.md', 'a.txt'])

    await ops.checkoutLayer(runId, repoName, { stack: 2, layer: 1 }, 'main')
    expect(files()).toEqual(['README.md', 'c.txt'])
  })

  test('checkout of a missing layer fails without touching the worktree', async () => {
    const { ops, runId, repoName, write, git } = setup()
    write('a.txt', 'a\n')

    await expect(
      ops.checkoutLayer(runId, repoName, { stack: 3, layer: 1 }, 'main'),
    ).rejects.toThrow('Stack 3 layer 1 does not exist')

    expect(git('git status --porcelain')).toBe('?? a.txt')
  })

  test('new layer stacks on the top of the current stack after restacking', async () => {
    const { ops, runId, repoName, write, git } = setup()

    write('a.txt', 'a\n')
    await ops.newLayer(runId, repoName, 'main')
    write('b.txt', 'b\n')
    await ops.checkoutLayer(runId, repoName, { stack: 1, layer: 1 }, 'main')
    write('a.txt', 'a2\n')

    const created = await ops.newLayer(runId, repoName, 'main')

    expect(created).toMatchObject({
      stack: 1,
      layer: 3,
      parentBranch: 'shuttle/session_1-stack/glue/2',
    })

    expect(git('git show HEAD:a.txt')).toBe('a2')
    expect(git('git show HEAD:b.txt')).toBe('b')
  })
})

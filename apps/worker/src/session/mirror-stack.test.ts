import { afterEach, describe, expect, test } from 'bun:test'

import type { CommitChangesetInput } from '../github/git-data'
import type { PullSummary } from '../github/pulls'
import { createStackGitFixture, type StackGitFixture } from '../sandbox/stack-git-fixture'
import type { LinkedSandboxRepo } from '../sandbox/workspace'
import { mirrorRepoStack, type MirrorGitHub, type MirrorInput } from './mirror-stack'
import { stackKey, type SessionStacks } from './stack-state'

const repo: LinkedSandboxRepo = {
  installationId: 1,
  owner: 'acme',
  name: 'glue',
  fullName: 'acme/glue',
  defaultBranch: 'main',
  private: false,
}

type Tree = Readonly<Record<string, string>>

/** GitHub double that keeps every commit's full tree so PR heads can be compared to local layers. */
function fakeGitHub(baseSha: string, baseTree: Tree) {
  const commits = new Map<string, Tree>([[baseSha, baseTree]])
  const pulls = new Map<number, { head: string; base: string; title: string }>()
  const heads = new Map<string, string>()
  const stacks: { number: number; pulls: number[] }[] = []
  const calls: string[] = []

  const summary = (number: number): PullSummary => {
    const pull = pulls.get(number)!

    return {
      installationId: repo.installationId,
      fullName: repo.fullName,
      number,
      title: pull.title,
      body: '',
      url: `https://github.com/acme/glue/pull/${number}`,
      state: 'open',
      draft: true,
      authorLogin: 'shuttle[bot]',
      authorAvatarUrl: '',
      headRef: pull.head,
      headSha: heads.get(pull.head) ?? '',
      baseRef: pull.base,
      baseSha: '',
      additions: 0,
      deletions: 0,
      reviewDecision: 'none',
      checkRollup: 'neutral',
      updatedAt: 0,
      isFork: false,
      stack: null,
    }
  }

  const github: MirrorGitHub = {
    commitChangeset: async (input: CommitChangesetInput) => {
      calls.push(
        input.authorUserId === undefined || input.authorUserId === null
          ? `commit ${input.branch}`
          : `commit ${input.branch} as ${input.authorUserId}`,
      )

      const parent = commits.get(input.baseSha)

      if (!parent) {
        throw new Error(`GitHub has no commit ${input.baseSha}`)
      }

      const tree = { ...parent }

      for (const file of input.files) {
        if (file.content === null) {
          delete tree[file.path]
        } else {
          tree[file.path] = file.content
        }
      }

      const commitSha = `remote${commits.size}`
      commits.set(commitSha, tree)
      heads.set(input.branch, commitSha)
      return { commitSha, treeSha: `${commitSha}-tree`, branch: input.branch }
    },
    createPullRequest: async (input) => {
      const number = pulls.size + 1
      calls.push(`create #${number} ${input.head} -> ${input.base}`)
      pulls.set(number, { head: input.head, base: input.base, title: input.title })
      return summary(number)
    },
    updatePullRequest: async (input) => {
      calls.push(`update #${input.number} -> ${input.base}`)
      const pull = pulls.get(input.number)!
      pulls.set(input.number, { ...pull, base: input.base ?? pull.base })
      return summary(input.number)
    },
    createStack: async (_repo, pullNumbers) => {
      calls.push(`stack ${pullNumbers.join(',')}`)
      stacks.push({ number: stacks.length + 1, pulls: [...pullNumbers] })
      return { number: stacks.length, url: `stack/${stacks.length}`, pullNumbers }
    },
    addToStack: async (_repo, stackNumber, pullNumbers) => {
      calls.push(`stack ${stackNumber} += ${pullNumbers.join(',')}`)
      stacks[stackNumber - 1]!.pulls.push(...pullNumbers)
      return { number: stackNumber, url: `stack/${stackNumber}`, pullNumbers }
    },
  }

  return {
    github,
    calls,
    stacks,
    pullBase: (number: number) => pulls.get(number)?.base,
    headTree: (branch: string) => commits.get(heads.get(branch) ?? ''),
  }
}

describe('mirrorRepoStack', () => {
  let fixture: StackGitFixture | null = null

  afterEach(() => {
    fixture?.cleanup()
    fixture = null
  })

  const setup = () => {
    const current = createStackGitFixture()
    fixture = current
    const { ops, runId, baseSha } = current
    const git = (command: string) => current.git(command)

    const write = (path: string, content: string) => {
      current.write(path, content)
    }

    const remote = fakeGitHub(baseSha, { 'README.md': 'base\n' })
    let stacks: SessionStacks = {}

    const publish = async (input: Partial<MirrorInput> = {}) => {
      const result = await mirrorRepoStack(
        remote.github,
        ops,
        runId,
        repo,
        { title: 'Change', body: '', draft: true, stackId: null, layer: null, ...input },
        stacks,
      )

      stacks = { ...stacks, [stackKey(repo.name, result.stackId)]: result.stack }
      return result
    }

    const localTree = (branch: string): Tree =>
      Object.fromEntries(
        git(`git ls-tree -r --name-only ${branch}`)
          .split('\n')
          .map((path) => [path, `${git(`git show ${branch}:${path}`)}\n`]),
      )

    return { ops, runId, write, ...remote, publish, localTree, stacks: () => stacks }
  }

  test('publishes a stack and a standalone PR from one session', async () => {
    const { ops, runId, write, publish, calls, pullBase, headTree, localTree, stacks } = setup()

    write('a.txt', 'a\n')
    const first = await publish()

    await ops.newLayer(runId, repo.name, 'main')
    write('b.txt', 'b\n')
    const second = await publish()

    expect(first.stackId).toBe(1)
    expect(second.stackId).toBe(1)

    expect(second.layers.map((layer) => [layer.layer, layer.number, layer.outcome])).toEqual([
      [1, 1, 'unchanged'],
      [2, 2, 'opened'],
    ])

    await ops.newStack(runId, repo.name, 'main')
    write('c.txt', 'c\n')
    const standalone = await publish({ stackId: 2, layer: 1 })

    expect(standalone.stackId).toBe(2)

    expect(standalone.layers.map((layer) => [layer.layer, layer.number, layer.outcome])).toEqual([
      [1, 3, 'opened'],
    ])

    expect(pullBase(1)).toBe('main')
    expect(pullBase(2)).toBe('shuttle/session_1/glue')
    expect(pullBase(3)).toBe('main')

    for (const branch of [
      'shuttle/session_1/glue',
      'shuttle/session_1-stack/glue/2',
      'shuttle/session_1-stack2/glue/1',
    ]) {
      expect(headTree(branch)).toEqual(localTree(branch))
    }

    expect(headTree('shuttle/session_1-stack2/glue/1')).toEqual({
      'README.md': 'base\n',
      'c.txt': 'c\n',
    })

    expect(calls.filter((call) => call.startsWith('stack'))).toEqual(['stack 1,2'])
    expect(Object.keys(stacks()).toSorted()).toEqual(['glue', 'glue#2'])
    expect(stacks()['glue']!.native).toEqual({ number: 1, url: 'stack/1' })
    expect(stacks()['glue#2']!.native).toBeNull()
  })

  test('editing a lower layer republishes it and cascades onto the new remote commit', async () => {
    const { ops, runId, write, publish, calls, headTree, localTree } = setup()

    write('a.txt', 'a\n')
    await publish()
    await ops.newLayer(runId, repo.name, 'main')
    write('b.txt', 'b\n')
    await publish()
    await ops.newStack(runId, repo.name, 'main')
    write('c.txt', 'c\n')
    await publish()

    calls.length = 0
    await ops.checkoutLayer(runId, repo.name, { stack: 1, layer: 1 }, 'main')
    write('a.txt', 'a fixed\n')
    const result = await publish({ stackId: 1, layer: 1 })

    expect(result.layers.map((layer) => [layer.layer, layer.outcome])).toEqual([
      [1, 'updated'],
      [2, 'updated'],
    ])

    expect(result.layers[1]!.baseSha).toBe(result.layers[0]!.remoteSha)

    expect(headTree('shuttle/session_1-stack/glue/2')).toEqual(
      localTree('shuttle/session_1-stack/glue/2'),
    )

    expect(headTree('shuttle/session_1-stack/glue/2')?.['a.txt']).toBe('a fixed\n')
    expect(calls.some((call) => call.includes('stack2'))).toBe(false)
  })

  test('the stamped stack is published even after the worktree moved to another stack', async () => {
    const { ops, runId, write, publish, pullBase } = setup()

    write('a.txt', 'a\n')
    await ops.newStack(runId, repo.name, 'main')
    write('c.txt', 'c\n')

    const result = await publish({ stackId: 1, layer: 1 })

    expect(result.stackId).toBe(1)
    expect(result.layers.map((layer) => layer.branch)).toEqual(['shuttle/session_1/glue'])
    expect(pullBase(1)).toBe('main')
  })

  test('an unchanged stack makes no GitHub calls', async () => {
    const { write, publish, calls } = setup()

    write('a.txt', 'a\n')
    await publish()
    calls.length = 0

    const again = await publish()

    expect(again.layers.map((layer) => layer.outcome)).toEqual(['unchanged'])
    expect(calls).toEqual([])
  })

  test('commits are credited to the person who approved the publish', async () => {
    const { write, publish, calls } = setup()

    write('a.txt', 'a\n')
    await publish({ authorUserId: 'user_1' })

    expect(calls.filter((call) => call.startsWith('commit '))).toEqual([
      'commit shuttle/session_1/glue as user_1',
    ])
  })

  test('publishing a stack that does not exist fails clearly', async () => {
    const { publish } = setup()

    let message = ''

    try {
      await publish({ stackId: 4 })
    } catch (error) {
      message = error instanceof Error ? error.message : ''
    }

    expect(message).toContain('Stack 4 does not exist in glue')
  })
})

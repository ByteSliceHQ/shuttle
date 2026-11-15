import { describe, expect, test } from 'bun:test'

import type { StackStatus, StackStatusLayer } from '../../sandbox/stack'
import type { SessionStacks } from '../../session/stack-state'
import { newStackBlocker } from './stack'

function layer(files: readonly string[], address = { stack: 1, layer: 1 }): StackStatusLayer {
  return {
    ...address,
    branch: 'shuttle/run_1/demo',
    parentBranch: 'main',
    tipSha: 'tip',
    treeSha: 'tree',
    pending: files.length > 0,
    files,
  }
}

function status(files: readonly string[], address = { stack: 1, layer: 1 }): StackStatus {
  const layers = [layer(files, address)]

  return {
    repo: 'demo',
    currentStack: address.stack,
    currentLayer: address.layer,
    layers,
    stacks: [{ stack: address.stack, baseSha: 'base', layers }],
    pending: files.length > 0,
  }
}

function publishedLayer(key: string, layerNumber: number): SessionStacks {
  return {
    [key]: {
      native: null,
      layers: [
        {
          layer: layerNumber,
          branch: 'shuttle/run_1/demo',
          parentBranch: 'main',
          pull: { number: 7, url: 'https://github.com/acme/demo/pull/7', draft: true },
          remoteSha: 'remote',
          publishedTree: 'tree',
        },
      ],
    },
  }
}

describe('new_stack guard', () => {
  test('refuses while the first layer holds edits that were never proposed', () => {
    const blocker = newStackBlocker(status(['index.html', 'app.js']), {})

    expect(blocker).toContain('Stack 1 layer 1 has unpublished edits')
    expect(blocker).toContain('index.html, app.js')
    expect(blocker).toContain('propose_pull_request')
  })

  test('names only the first few files of a large change', () => {
    const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g']

    expect(newStackBlocker(status(files), {})).toContain('(a, b, c, d, e, and 2 more)')
  })

  test('allows a clean worktree', () => {
    expect(newStackBlocker(status([]), {})).toBeNull()
  })

  test('allows pending edits on a layer that already has a PR', () => {
    expect(newStackBlocker(status(['app.js']), publishedLayer('demo', 1))).toBeNull()
  })

  test('a PR on another stack does not cover the current one', () => {
    const second = status(['app.js'], { stack: 2, layer: 1 })

    expect(newStackBlocker(second, publishedLayer('demo', 1))).toContain('Stack 2 layer 1')
    expect(newStackBlocker(second, publishedLayer('demo#2', 1))).toBeNull()
  })
})

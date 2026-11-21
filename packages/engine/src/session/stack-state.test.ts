import { describe, expect, test } from 'bun:test'

import {
  stackKey,
  withPrProposal,
  withStackPublished,
  type SessionRepoStack,
  type StackSessionSlice,
} from './stack-state'

const baseState: StackSessionSlice = {
  repos: [{ name: 'glue', fullName: 'ByteSliceHQ/glue' }],
  pendingPrPublish: null,
  stacks: {
    glue: {
      layers: [
        {
          layer: 1,
          branch: 'shuttle/run/glue',
          parentBranch: 'main',
          pull: { number: 10, url: 'https://example/10', draft: true },
          remoteSha: 'aaa',
          publishedTree: 'tree1',
        },
        {
          layer: 2,
          branch: 'shuttle/run-stack/glue/2',
          parentBranch: 'shuttle/run/glue',
          pull: { number: 11, url: 'https://example/11', draft: true },
          remoteSha: 'bbb',
          publishedTree: 'tree2',
        },
      ],
      native: null,
    } satisfies SessionRepoStack,
  },
  discardedPrApprovalId: null,
}

describe('withPrProposal', () => {
  test('uses the stamped worktree layer instead of stacks.layers.length', () => {
    const next = withPrProposal(
      baseState,
      {
        approvalId: 'pr_publish_1',
        title: 'Fix layer 1',
        body: 'body',
        draft: true,
        repos: ['glue'],
        repo: 'glue',
        layer: 1,
      },
      'thr_conductor',
    )

    expect(next.pendingPrPublish?.layer).toBe(1)
    expect(next.pendingPrPublish?.parentPull).toBeNull()
    expect(next.pendingPrPublish?.restacks).toEqual([11])
  })

  test('does not guess layer from stack length when layer is missing', () => {
    const next = withPrProposal(
      baseState,
      {
        approvalId: 'pr_publish_2',
        title: 'No layer',
        body: 'body',
        draft: true,
        repos: ['glue'],
        repo: 'glue',
      },
      'thr_conductor',
    )

    expect(next.pendingPrPublish?.layer).toBeNull()
    expect(next.pendingPrPublish?.stackId).toBeNull()
    expect(next.pendingPrPublish?.parentPull).toBeNull()
    expect(next.pendingPrPublish?.restacks).toEqual([])
  })

  test('a standalone stack never borrows parent or restacks from stack 1', () => {
    const next = withPrProposal(
      baseState,
      {
        approvalId: 'pr_publish_3',
        title: 'Standalone',
        body: 'body',
        draft: true,
        repos: ['glue'],
        repo: 'glue',
        stackId: 2,
        layer: 1,
      },
      'thr_conductor',
    )

    expect(next.pendingPrPublish?.stackId).toBe(2)
    expect(next.pendingPrPublish?.parentPull).toBeNull()
    expect(next.pendingPrPublish?.restacks).toEqual([])
  })

  test('legacy proposals without stackId resolve to stack 1', () => {
    const next = withPrProposal(
      baseState,
      {
        approvalId: 'pr_publish_4',
        title: 'Layer 2',
        body: 'body',
        draft: true,
        repos: ['glue'],
        repo: 'glue',
        layer: 2,
      },
      'thr_conductor',
    )

    expect(next.pendingPrPublish?.stackId).toBe(1)
    expect(next.pendingPrPublish?.parentPull).toEqual({ fullName: 'ByteSliceHQ/glue', number: 10 })
  })
})

describe('withStackPublished', () => {
  const standaloneLayer = {
    layer: 1,
    branch: 'shuttle/run-stack2/glue/1',
    parentBranch: 'main',
    pull: { number: 12, url: 'https://example/12', draft: true },
    remoteSha: 'ccc',
    publishedTree: 'tree3',
  }

  test('stores each stack under its own key and leaves stack 1 untouched', () => {
    const next = withStackPublished(baseState, {
      repo: 'glue',
      stackId: 2,
      layers: [standaloneLayer],
    })

    expect(Object.keys(next.stacks).toSorted()).toEqual(['glue', 'glue#2'])
    expect(next.stacks['glue']).toBe(baseState.stacks['glue'])
    expect(next.stacks[stackKey('glue', 2)]).toEqual({ layers: [standaloneLayer], native: null })
  })

  test('events without stackId update stack 1', () => {
    const next = withStackPublished(baseState, {
      repo: 'glue',
      layers: [{ ...standaloneLayer, branch: 'shuttle/run/glue' }],
      stack: { number: 7, url: 'https://example/stack/7' },
    })

    expect(Object.keys(next.stacks)).toEqual(['glue'])
    expect(next.stacks['glue']?.native).toEqual({ number: 7, url: 'https://example/stack/7' })
  })
})

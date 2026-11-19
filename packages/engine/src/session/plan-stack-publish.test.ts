import { describe, expect, test } from 'bun:test'

import { planStackPublish } from './plan-stack-publish'

describe('planStackPublish', () => {
  test('returns empty when every layer matches its published tree', () => {
    expect(
      planStackPublish([
        {
          layer: 1,
          branch: 'a',
          parentBranch: 'main',
          localTree: 't1',
          publishedTree: 't1',
        },
        {
          layer: 2,
          branch: 'b',
          parentBranch: 'a',
          localTree: 't2',
          publishedTree: 't2',
        },
      ]),
    ).toEqual([])
  })

  test('a new top layer is the only planned entry', () => {
    const plan = planStackPublish([
      {
        layer: 1,
        branch: 'a',
        parentBranch: 'main',
        localTree: 't1',
        publishedTree: 't1',
      },
      {
        layer: 2,
        branch: 'b',
        parentBranch: 'a',
        localTree: 't2',
        publishedTree: null,
      },
    ])

    expect(plan.map((entry) => ({ layer: entry.layer, reason: entry.reason }))).toEqual([
      { layer: 2, reason: 'new' },
    ])
  })

  test('editing a middle layer cascades upward', () => {
    const plan = planStackPublish([
      {
        layer: 1,
        branch: 'a',
        parentBranch: 'main',
        localTree: 't1',
        publishedTree: 't1',
      },
      {
        layer: 2,
        branch: 'b',
        parentBranch: 'a',
        localTree: 't2-new',
        publishedTree: 't2',
      },
      {
        layer: 3,
        branch: 'c',
        parentBranch: 'b',
        localTree: 't3',
        publishedTree: 't3',
      },
    ])

    expect(plan.map((entry) => ({ layer: entry.layer, reason: entry.reason }))).toEqual([
      { layer: 2, reason: 'changed' },
      { layer: 3, reason: 'cascade' },
    ])
  })
})

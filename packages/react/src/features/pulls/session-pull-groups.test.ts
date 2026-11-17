import { describe, expect, test } from 'bun:test'

import type { PublishedPull } from '../sessions/session-feed'
import { shuttleStackPosition } from './pulls'
import { groupSessionPulls } from './session-pull-groups'

function pull(number: number, stack?: PublishedPull['stack'], fullName = 'acme/glue') {
  return { fullName, number, url: '', draft: true, ...(stack ? { stack } : {}) }
}

function describeGroups(pulls: readonly PublishedPull[]) {
  const groups = groupSessionPulls(pulls)

  return {
    stacks: groups.stacks.map((stack) => stack.layers.map((layer) => layer.number)),
    standalone: groups.standalone.map((entry) => entry.number),
  }
}

describe('groupSessionPulls', () => {
  test('a stack and a standalone PR in the same repo stay separate', () => {
    expect(
      describeGroups([
        pull(9, { id: 1, layer: 1 }),
        pull(10, { id: 1, layer: 2 }),
        pull(11, { id: 1, layer: 3 }),
        pull(12, { id: 2, layer: 1 }),
      ]),
    ).toEqual({ stacks: [[11, 10, 9]], standalone: [12] })
  })

  test('same-repo PRs without stack info are not treated as a stack', () => {
    expect(describeGroups([pull(1), pull(2)])).toEqual({ stacks: [], standalone: [1, 2] })
  })

  test('separate stacks and repos never merge', () => {
    expect(
      describeGroups([
        pull(1, { id: 1, layer: 1 }),
        pull(2, { id: 1, layer: 2 }),
        pull(3, { id: 2, layer: 1 }),
        pull(4, { id: 2, layer: 2 }),
        pull(5, { id: 1, layer: 1 }, 'acme/web'),
      ]),
    ).toEqual({
      stacks: [
        [2, 1],
        [4, 3],
      ],
      standalone: [5],
    })
  })
})

describe('shuttleStackPosition', () => {
  test('reads stack and layer from Shuttle head branches', () => {
    expect(shuttleStackPosition('shuttle/session_1/glue')).toEqual({ id: 1, layer: 1 })
    expect(shuttleStackPosition('shuttle/session_1-stack/glue/3')).toEqual({ id: 1, layer: 3 })
    expect(shuttleStackPosition('shuttle/session_1-stack2/glue/1')).toEqual({ id: 2, layer: 1 })
    expect(shuttleStackPosition('feature/login')).toBeUndefined()
  })
})

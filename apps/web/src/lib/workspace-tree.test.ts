import { describe, expect, test } from 'bun:test'

import type { WorkspaceRepo } from './sandbox'
import {
  changeAt,
  changeCount,
  initiallyExpanded,
  workspaceFiles,
  workspaceTree,
  type WorkspaceNode,
} from './workspace-tree'

const web: WorkspaceRepo = {
  name: 'web',
  fullName: 'acme/web',
  defaultBranch: 'main',
  files: ['README.md', 'src/app.ts', 'src/todo.ts', 'src/lib/api.ts'],
  changes: [
    { path: 'src/app.ts', status: 'M' },
    { path: 'src/todo.ts', status: 'A' },
    { path: 'old.txt', status: 'D' },
  ],
}

const docs: WorkspaceRepo = {
  name: 'docs',
  fullName: 'acme/docs',
  defaultBranch: 'main',
  files: ['index.md'],
  changes: [],
}

const outline = (nodes: readonly WorkspaceNode[], depth = 0): string[] =>
  nodes.flatMap((node) => [
    `${'  '.repeat(depth)}${node.name}${node.status ? ` ${node.status}` : ''}${node.kind === 'file' ? '' : ` (${node.changed})`}`,
    ...outline(node.children, depth + 1),
  ])

describe('workspaceTree', () => {
  test('all: every file under its repository, folders first, with change marks and counts', () => {
    expect(outline(workspaceTree([web, docs], 'all'))).toEqual([
      'web (2)',
      '  src (2)',
      '    lib (0)',
      '      api.ts',
      '    app.ts M',
      '    todo.ts A',
      '  README.md',
      'docs (0)',
      '  index.md',
    ])
  })

  test('changed: only what the session touched, deletions included', () => {
    expect(outline(workspaceTree([web, docs], 'changed'))).toEqual([
      'web (3)',
      '  src (2)',
      '    app.ts M',
      '    todo.ts A',
      '  old.txt D',
      'docs (0)',
    ])
  })

  test('paths name the repository, so the same file in two repositories stays apart', () => {
    const [first] = workspaceTree([web], 'all')

    expect(first?.children.at(-1)?.path).toBe('web/README.md')
    expect(workspaceFiles([web, docs])).toContain('docs/index.md')
  })
})

describe('helpers', () => {
  test('look up a change and count them', () => {
    expect(changeAt([web, docs], 'web/src/todo.ts')).toBe('A')
    expect(changeAt([web, docs], 'web/README.md')).toBeUndefined()
    expect(changeAt([web, docs], 'nope/src/todo.ts')).toBeUndefined()
    expect(changeCount([web, docs])).toBe(3)
  })

  test('repositories and their top folders start open', () => {
    expect([...initiallyExpanded(workspaceTree([web, docs], 'all'))]).toEqual([
      'web',
      'web/src',
      'docs',
    ])
  })
})

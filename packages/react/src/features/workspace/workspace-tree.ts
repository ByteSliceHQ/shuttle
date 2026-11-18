import type { ChangeStatus, SandboxWorkspaceRepo as WorkspaceRepo } from '@shuttle/api'

/**
 * The tree the Workspace tab draws: repositories at the top, their folders and files beneath.
 * A node's `path` is `<repository>/<path in it>`, which is also how files are asked for.
 */

export type WorkspaceFilter = 'all' | 'changed'

export interface WorkspaceNode {
  readonly name: string
  readonly path: string
  readonly kind: 'repo' | 'dir' | 'file'
  /** For a file: how the session changed it, if it did. */
  readonly status?: ChangeStatus
  /** How many changed files are at or beneath this node. */
  readonly changed: number
  readonly children: readonly WorkspaceNode[]
}

interface Building {
  name: string
  path: string
  kind: 'repo' | 'dir' | 'file'
  status?: ChangeStatus
  changed: number
  children: Building[]
}

function sortNodes(node: Building): void {
  node.children.sort((left, right) =>
    left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === 'file' ? 1 : -1,
  )

  node.children.forEach(sortNodes)
}

/**
 * One node per repository, holding every file (`all`) or only the files the session added,
 * changed or deleted (`changed`). Deleted files appear only under `changed`: they are no longer
 * files, but they are part of what was done.
 */
export function workspaceTree(
  repos: readonly WorkspaceRepo[],
  filter: WorkspaceFilter,
): WorkspaceNode[] {
  return repos.map((repo) => {
    const statuses = new Map(repo.changes.map((change) => [change.path, change.status]))

    const root: Building = {
      name: repo.name,
      path: repo.name,
      kind: 'repo',
      changed: 0,
      children: [],
    }

    const paths = filter === 'changed' ? repo.changes.map((change) => change.path) : repo.files

    for (const path of paths) {
      const parts = path.split('/').filter(Boolean)
      const status = statuses.get(path)
      let cursor = root

      if (status !== undefined) {
        root.changed += 1
      }

      parts.forEach((name, index) => {
        const isFile = index === parts.length - 1
        const at = `${repo.name}/${parts.slice(0, index + 1).join('/')}`
        let child = cursor.children.find((node) => node.name === name && node.kind !== 'repo')

        if (!child) {
          child = { name, path: at, kind: isFile ? 'file' : 'dir', changed: 0, children: [] }
          cursor.children.push(child)
        }

        if (status !== undefined) {
          child.changed += 1
        }

        if (isFile && status !== undefined) {
          child.status = status
        }

        cursor = child
      })
    }

    sortNodes(root)

    return root
  })
}

/** Every file in the workspace, as `<repository>/<path>`. */
export function workspaceFiles(repos: readonly WorkspaceRepo[]): string[] {
  return repos.flatMap((repo) => repo.files.map((path) => `${repo.name}/${path}`))
}

/** How the session changed the file at `path`, if it did. */
export function changeAt(repos: readonly WorkspaceRepo[], path: string): ChangeStatus | undefined {
  const slash = path.indexOf('/')
  const repo = repos.find((item) => item.name === path.slice(0, slash))

  return repo?.changes.find((change) => change.path === path.slice(slash + 1))?.status
}

/** How many files the session changed across the workspace. */
export function changeCount(repos: readonly WorkspaceRepo[]): number {
  return repos.reduce((total, repo) => total + repo.changes.length, 0)
}

/** The folders open to start with: each repository, and the folders directly inside it. */
export function initiallyExpanded(nodes: readonly WorkspaceNode[]): Set<string> {
  return new Set(
    nodes.flatMap((repo) => [
      repo.path,
      ...repo.children.filter((child) => child.kind === 'dir').map((child) => child.path),
    ]),
  )
}

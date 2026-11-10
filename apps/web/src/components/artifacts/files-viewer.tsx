import { Files } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { EmptyState } from '@/components/ui/panel'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/cn'
import { fetchSandboxFiles, type SandboxFileEntry } from '@/lib/sandbox'

const POLL_MS = 2_500

export function FilesViewer({
  runId,
  folderId,
  identities,
  onOpenFile,
}: {
  runId: string
  folderId?: string
  identities: ReadonlyMap<string, { label: string }>
  onOpenFile: (path: string) => void
}) {
  const [entries, setEntries] = useState<SandboxFileEntry[] | null>(null)
  const [mode, setMode] = useState<'memory' | 'container' | undefined>()
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())

  useEffect(() => {
    let cancelled = false

    const load = () => {
      void fetchSandboxFiles({ runId, folderId })
        .then((result) => {
          if (cancelled) {
            return
          }

          setEntries(result.files)
          setMode(result.mode)
          setError(null)

          const roots = new Set(
            result.files
              .map((entry) => entry.path.split('/').slice(0, 2).join('/'))
              .filter(Boolean),
          )

          setExpanded((prev) => (prev.size > 0 ? prev : roots))
        })
        .catch((cause: unknown) => {
          if (cancelled) {
            return
          }

          setError(cause instanceof Error ? cause.message : 'Failed to load files')
          setEntries([])
        })
    }

    load()
    const timer = window.setInterval(load, POLL_MS)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [runId, folderId])

  const tree = useMemo(() => buildTree(entries ?? []), [entries])

  if (error) {
    return (
      <EmptyState icon={<Files />} title="Files unavailable">
        {error}
      </EmptyState>
    )
  }

  if (!entries) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-xs">
        Loading files…
      </div>
    )
  }

  if (entries.length === 0) {
    return (
      <EmptyState icon={<Files />} title="No files yet">
        {mode === 'container'
          ? 'The sandbox worktree is empty. Container disk resets on rebuilds — Events may still describe files that are no longer on disk.'
          : 'The sandbox worktree is empty until agents write files.'}
      </EmptyState>
    )
  }

  return (
    <ScrollArea className="h-full">
      <ul className="py-1.5 font-mono text-[11px]">
        {tree.map((node) => (
          <TreeNode
            key={node.path}
            node={node}
            depth={0}
            expanded={expanded}
            identities={identities}
            onToggle={(path) => {
              setExpanded((prev) => {
                const next = new Set(prev)

                if (next.has(path)) {
                  next.delete(path)
                } else {
                  next.add(path)
                }

                return next
              })
            }}
            onOpenFile={onOpenFile}
          />
        ))}
      </ul>
    </ScrollArea>
  )
}

interface TreeNodeModel {
  readonly name: string
  readonly path: string
  readonly kind: 'dir' | 'file'
  readonly children: TreeNodeModel[]
}

function buildTree(entries: readonly SandboxFileEntry[]): TreeNodeModel[] {
  const root: TreeNodeModel = { name: '', path: '', kind: 'dir', children: [] }

  for (const entry of entries) {
    const parts = entry.path.split('/').filter(Boolean)
    let cursor = root

    for (let i = 0; i < parts.length; i++) {
      const name = parts[i] ?? ''
      const path = parts.slice(0, i + 1).join('/')
      const isFile = i === parts.length - 1 && entry.kind === 'file'
      let child = cursor.children.find((node) => node.name === name)

      if (!child) {
        child = { name, path, kind: isFile ? 'file' : 'dir', children: [] }
        cursor.children.push(child)
      }

      cursor = child
    }
  }

  sortTree(root)

  return root.children
}

function sortTree(node: TreeNodeModel) {
  node.children.sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === 'dir' ? -1 : 1
    }

    return left.name.localeCompare(right.name)
  })

  for (const child of node.children) {
    sortTree(child)
  }
}

function TreeNode({
  node,
  depth,
  expanded,
  identities,
  onToggle,
  onOpenFile,
}: {
  node: TreeNodeModel
  depth: number
  expanded: ReadonlySet<string>
  identities: ReadonlyMap<string, { label: string }>
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
}) {
  const open = expanded.has(node.path)

  const label =
    depth === 0 ? (identities.get(node.name)?.label ?? shortLabel(node.name)) : node.name

  if (node.kind === 'file') {
    return (
      <li>
        <button
          type="button"
          onClick={() => onOpenFile(node.path)}
          className="hover:bg-accent/50 flex w-full items-center gap-1.5 truncate px-2 py-0.5 text-left transition-colors duration-100"
          style={{ paddingLeft: 8 + depth * 12 }}
          title={node.path}
        >
          <span className="text-muted-foreground/50">·</span>
          <span className="truncate">{label}</span>
        </button>
      </li>
    )
  }

  return (
    <li>
      <button
        type="button"
        onClick={() => onToggle(node.path)}
        className={cn(
          'hover:bg-accent/50 flex w-full items-center gap-1.5 truncate px-2 py-0.5 text-left transition-colors duration-100',
          depth === 0 && 'text-foreground font-medium',
        )}
        style={{ paddingLeft: 8 + depth * 12 }}
        title={node.path}
      >
        <span className="text-muted-foreground w-2.5 shrink-0">{open ? '▾' : '▸'}</span>
        <span className="truncate">{label}</span>
      </button>
      {open ? (
        <ul>
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              identities={identities}
              onToggle={onToggle}
              onOpenFile={onOpenFile}
            />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

function shortLabel(name: string): string {
  return name.length > 12 ? `${name.slice(0, 6)}…${name.slice(-4)}` : name
}

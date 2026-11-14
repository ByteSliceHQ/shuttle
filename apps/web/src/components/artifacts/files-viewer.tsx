import { ChevronRight, File, Files, Folder, FolderOpen, PanelLeft, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { EmptyState } from '@/components/ui/panel'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/cn'
import { fetchSandboxFiles, type SandboxFileEntry, type SandboxSource } from '@/lib/sandbox'
import { useWidthBucket } from '@/lib/use-width-bucket'

import { FileViewer } from './file-viewer'
import { ASLEEP_MESSAGE, SavedNote } from './saved-note'

const POLL_MS = 2_500

/** A saved copy only changes when the session works again, so it is checked less often. */
const SAVED_POLL_MS = 15_000

/** Below this width the tree and the file take turns instead of sitting side by side. */
const SIDE_BY_SIDE_PX = 420

/** The most files kept open at once. Opening another closes the one opened longest ago. */
const MAX_OPEN = 12

interface OpenFiles {
  readonly paths: readonly string[]
  readonly active: string | null
}

const NONE_OPEN: OpenFiles = { paths: [], active: null }

function storageKey(runId: string): string {
  return `shuttle:open-files:${runId}`
}

/** The files this browser tab had open in a session, so a reload comes back to them. */
function readOpenFiles(runId: string): OpenFiles {
  try {
    const stored = JSON.parse(sessionStorage.getItem(storageKey(runId)) ?? 'null') as unknown

    if (stored && typeof stored === 'object' && 'paths' in stored && Array.isArray(stored.paths)) {
      const paths = stored.paths.filter((path): path is string => typeof path === 'string')
      const active = 'active' in stored && typeof stored.active === 'string' ? stored.active : null

      return { paths, active: active && paths.includes(active) ? active : (paths.at(-1) ?? null) }
    }
  } catch {
    // Nothing stored, or storage is unavailable.
  }

  return NONE_OPEN
}

function withOpened(open: OpenFiles, path: string): OpenFiles {
  if (open.paths.includes(path)) {
    return { ...open, active: path }
  }

  return { paths: [...open.paths, path].slice(-MAX_OPEN), active: path }
}

function withClosed(open: OpenFiles, path: string): OpenFiles {
  const at = open.paths.indexOf(path)
  const paths = open.paths.filter((item) => item !== path)

  // Closing the file in view moves to its neighbour, as editors do.
  const active =
    open.active === path ? (paths[Math.min(at, paths.length - 1)] ?? null) : open.active

  return { paths, active }
}

/**
 * The Files tab: the session's file tree beside the file being read. Files open in a strip of
 * their own above the contents, which belongs to this tab and is separate from the pane's tabs.
 * Give it the session as its `key` so it starts fresh when the page moves to another session.
 */
export function FilesViewer({
  runId,
  folderId,
  identities,
  refreshEpoch,
  initialPath,
}: {
  runId: string
  folderId?: string
  identities: ReadonlyMap<string, { label: string }>
  refreshEpoch: number
  /** A file to have open from the start. */
  initialPath?: string
}) {
  const [entries, setEntries] = useState<SandboxFileEntry[] | null>(null)
  const [mode, setMode] = useState<'memory' | 'container' | undefined>()
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState<SandboxSource>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())

  const [open, setOpen] = useState<OpenFiles>(() => {
    const stored = readOpenFiles(runId)

    return initialPath ? withOpened(stored, initialPath) : stored
  })

  const [treeShown, setTreeShown] = useState(true)
  const [containerRef, bucket] = useWidthBucket<HTMLDivElement>([SIDE_BY_SIDE_PX])
  const sideBySide = bucket > 0

  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey(runId), JSON.stringify(open))
    } catch {
      // Storage is unavailable; the open files last until the page reloads.
    }
  }, [runId, open])

  useEffect(() => {
    let cancelled = false
    let live = true

    const load = () =>
      fetchSandboxFiles({ runId, folderId })
        .then((result) => {
          if (cancelled) {
            return
          }

          live = result.source !== 'saved' && result.source !== 'asleep'

          setEntries(result.files)
          setMode(result.mode)
          setSource({ source: result.source, savedAt: result.savedAt })
          setError(null)

          // Open to start with: each repository, and the folders directly inside it.
          const roots = new Set(
            result.files.flatMap((entry) => {
              const parts = entry.path.split('/')

              return [
                ...(parts.length > 1 ? [parts[0] ?? ''] : []),
                ...(parts.length > 2 ? [parts.slice(0, 2).join('/')] : []),
              ]
            }),
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

    let timer = 0

    const poll = () => {
      void load().finally(() => {
        if (!cancelled) {
          timer = window.setTimeout(poll, live ? POLL_MS : SAVED_POLL_MS)
        }
      })
    }

    poll()

    return () => {
      cancelled = true
      window.clearTimeout(timer)
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
        {source.source === 'asleep'
          ? ASLEEP_MESSAGE
          : mode === 'container'
            ? 'This session has no files yet. They appear here as agents write them.'
            : 'The sandbox worktree is empty until agents write files.'}
      </EmptyState>
    )
  }

  const openFile = (path: string) => {
    setOpen((current) => withOpened(current, path))

    // With room for only one of them, picking a file moves to it.
    if (!sideBySide) {
      setTreeShown(false)
    }
  }

  const explorer = (
    <ScrollArea className="h-full">
      <ul className="py-1.5 text-[12px]" role="tree" aria-label="Files">
        {tree.map((node) => (
          <TreeNode
            key={node.path}
            node={node}
            depth={0}
            expanded={expanded}
            identities={identities}
            activePath={open.active}
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
            onOpenFile={openFile}
          />
        ))}
      </ul>
    </ScrollArea>
  )

  const contents = (
    <div className="bg-background flex h-full min-h-0 min-w-0 flex-col">
      <OpenFileStrip
        open={open}
        treeShown={treeShown}
        onToggleTree={() => setTreeShown((shown) => !shown)}
        onSelect={(path) => setOpen((current) => ({ ...current, active: path }))}
        onClose={(path) => setOpen((current) => withClosed(current, path))}
      />
      <div className="min-h-0 flex-1">
        {open.active ? (
          <FileViewer
            runId={runId}
            folderId={folderId}
            path={open.active}
            refreshEpoch={refreshEpoch}
          />
        ) : (
          <EmptyState icon={<File />} title="No file open">
            Pick a file from the tree to read it here.
          </EmptyState>
        )}
      </div>
    </div>
  )

  return (
    <div ref={containerRef} className="flex h-full min-h-0 flex-col">
      <SavedNote source={source} />
      <div className="min-h-0 flex-1">
        {sideBySide && treeShown ? (
          <ResizablePanelGroup orientation="horizontal">
            <ResizablePanel id="file-tree" defaultSize="34" minSize={130} maxSize="60">
              {explorer}
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel id="file-contents" minSize={200}>
              {contents}
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : treeShown ? (
          <div className="flex h-full min-h-0 flex-col">
            {open.active ? (
              <button
                type="button"
                onClick={() => setTreeShown(false)}
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex h-8 shrink-0 items-center gap-1.5 border-b px-2.5 text-left text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-inset"
              >
                <ChevronRight className="size-3 rotate-180" />
                <span className="truncate">Back to {open.active.split('/').pop()}</span>
              </button>
            ) : null}
            <div className="min-h-0 flex-1">{explorer}</div>
          </div>
        ) : (
          contents
        )}
      </div>
    </div>
  )
}

/** The files open in this tab, with the one in view marked, and the button that shows the tree. */
function OpenFileStrip({
  open,
  treeShown,
  onToggleTree,
  onSelect,
  onClose,
}: {
  open: OpenFiles
  treeShown: boolean
  onToggleTree: () => void
  onSelect: (path: string) => void
  onClose: (path: string) => void
}) {
  // Two open files with the same name are told apart by their folder.
  const names = open.paths.map((path) => path.split('/').pop() ?? path)

  return (
    <div className="flex h-8 shrink-0 items-stretch border-b">
      <button
        type="button"
        onClick={onToggleTree}
        aria-label={treeShown ? 'Hide file tree' : 'Show file tree'}
        aria-pressed={treeShown}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex w-8 shrink-0 items-center justify-center border-r outline-none focus-visible:ring-2 focus-visible:ring-inset"
      >
        <PanelLeft className="size-3.5" />
      </button>
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto" role="tablist">
        {open.paths.map((path, index) => {
          const active = path === open.active
          const name = names[index] ?? path
          const twin = names.indexOf(name) !== names.lastIndexOf(name)
          const folder = path.split('/').slice(-2, -1)[0]

          return (
            <div
              key={path}
              className={cn(
                'group flex shrink-0 items-center border-r text-[11.5px]',
                active
                  ? 'bg-accent/50 text-foreground'
                  : 'text-muted-foreground hover:bg-accent/25',
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                title={path}
                onClick={() => onSelect(path)}
                className="focus-visible:ring-ring/50 h-full max-w-48 truncate py-0 pr-1 pl-2.5 font-mono outline-none focus-visible:ring-2 focus-visible:ring-inset"
              >
                {name}
                {twin && folder ? <span className="text-muted-foreground"> · {folder}</span> : null}
              </button>
              <button
                type="button"
                aria-label={`Close ${name}`}
                onClick={() => onClose(path)}
                className={cn(
                  'hover:bg-accent hover:text-foreground focus-visible:ring-ring/50 mr-1 flex size-4 items-center justify-center rounded-sm outline-none focus-visible:opacity-100 focus-visible:ring-2',
                  active ? 'opacity-70' : 'opacity-0 group-hover:opacity-70',
                )}
              >
                <X className="size-3" />
              </button>
            </div>
          )
        })}
      </div>
    </div>
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

    // Git's own bookkeeping is not part of the work.
    if (parts.includes('.git')) {
      continue
    }

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
  activePath,
  onToggle,
  onOpenFile,
}: {
  node: TreeNodeModel
  depth: number
  expanded: ReadonlySet<string>
  identities: ReadonlyMap<string, { label: string }>
  activePath: string | null
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
}) {
  const open = expanded.has(node.path)

  const label =
    depth === 0 ? (identities.get(node.name)?.label ?? shortLabel(node.name)) : node.name

  const rowClass =
    'focus-visible:ring-ring/50 flex h-6 w-full items-center gap-1.5 pr-2 text-left outline-none transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-inset'

  if (node.kind === 'file') {
    const active = node.path === activePath

    return (
      <li role="treeitem" aria-selected={active}>
        <button
          type="button"
          onClick={() => onOpenFile(node.path)}
          className={cn(
            rowClass,
            active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50',
          )}
          // Files line up with the names of the folders beside them, past the folder chevron.
          style={{ paddingLeft: 8 + depth * 12 + 14 }}
          title={node.path}
        >
          <File className="size-3.5 shrink-0 opacity-60" />
          <span className="truncate">{label}</span>
        </button>
      </li>
    )
  }

  const FolderIcon = open ? FolderOpen : Folder

  return (
    <li role="treeitem" aria-expanded={open}>
      <button
        type="button"
        onClick={() => onToggle(node.path)}
        className={cn(rowClass, 'hover:bg-accent/50', depth === 0 && 'font-medium')}
        style={{ paddingLeft: 8 + depth * 12 }}
        title={node.path}
      >
        <ChevronRight
          className={cn(
            'text-muted-foreground size-3 shrink-0 transition-transform duration-100',
            open && 'rotate-90',
          )}
        />
        <FolderIcon className="text-muted-foreground size-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </button>
      {open ? (
        <ul role="group">
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              identities={identities}
              activePath={activePath}
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

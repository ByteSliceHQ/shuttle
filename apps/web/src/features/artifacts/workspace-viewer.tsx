import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronRight,
  File,
  Files,
  Folder,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  Moon,
  Package,
  PanelRight,
  Search,
  TriangleAlert,
  X,
} from 'lucide-react'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { EmptyState, Kbd } from '@/components/ui/panel'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  authoredPullsForSession,
  pullInbox,
  reviewedPullForSession,
  usePullsRunId,
} from '@/features/pulls/pulls'
import {
  changeAt,
  changeCount,
  initiallyExpanded,
  workspaceFiles,
  workspaceTree,
  type WorkspaceFilter,
  type WorkspaceNode,
} from '@/features/workspace/workspace-tree'
import { cn } from '@/lib/cn'
import { fullDateTime, relativeTime } from '@/lib/time'
import { useNow } from '@/lib/use-now'
import { useWidthBucket } from '@/lib/use-width-bucket'
import { useApi, useOrgPeople, useShuttleHost, useTenant } from '@/shuttle'
import type { ChangeStatus, SandboxWorkspace } from '@shuttle/api'
import { useProjection, useRunStore } from '@swirls/looms/react'

import { FileQuickOpen, quickOpenShortcut } from './file-quick-open'
import { invalidateWorktree, type WorkspaceRepo } from './sandbox'

/** The file pane brings the code and diff renderer with it, so it loads when a file is first opened. */
const FilePane = lazy(() => import('./file-pane'))

const POLL_MS = 4_000

/** A saved copy only changes when the session works again, so it is checked less often. */
const SAVED_POLL_MS = 15_000

/** Below this width the tree and the file take turns instead of sitting side by side. */
const SIDE_BY_SIDE_PX = 420

/** How recent a search request must be for a tab that has just appeared to act on it. */
const SEARCH_REQUEST_FRESH_MS = 1_500

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

const STATUS_LABEL: Record<ChangeStatus, string> = { A: 'Added', M: 'Modified', D: 'Deleted' }

const STATUS_CLASS: Record<ChangeStatus, string> = {
  A: 'text-status-completed',
  M: 'text-status-waiting',
  D: 'text-destructive',
}

/** A repository as people know it: its GitHub name, or "Scratch" for a folder with none linked. */
function repoLabel(repo: WorkspaceRepo): string {
  return repo.fullName ?? 'Scratch'
}

/**
 * The Workspace tab: everything the session is working on, in one place. Each repository's
 * files, which of them the session has changed, and the file or its changes beside the tree.
 * It reads the same whether there is no repository, one or several, and whoever's sandbox the
 * work happens to be in. Give it the session as its `key` so it starts fresh for another one.
 */
export function WorkspaceViewer({
  runId,
  initialPath,
  initialFilter,
  searchToken = 0,
}: {
  runId: string
  /** A file to have open from the start. */
  initialPath?: string
  /** The filter to start on. Left out, it starts on the changes when there are any. */
  initialFilter?: WorkspaceFilter
  /** When the file-search shortcut was last pressed, in milliseconds. Zero if never. */
  searchToken?: number
}) {
  const api = useApi()

  // The workspace is read again every few seconds while the tab's window is in front, and at
  // once when a save, a stray moved in, or the session's events say its files changed.
  const { data: workspace, error } = useQuery(
    api.sandbox.workspace.queryOptions({
      input: { id: runId },
      staleTime: 0,
      refetchInterval: (query) =>
        query.state.data && query.state.data.source !== 'sandbox' ? SAVED_POLL_MS : POLL_MS,
    }),
  )

  const [filter, setFilter] = useState<WorkspaceFilter | null>(initialFilter ?? null)
  const [expanded, setExpanded] = useState<ReadonlySet<string> | null>(null)
  const [unsaved, setUnsaved] = useState(false)

  const [open, setOpen] = useState<OpenFiles>(() => {
    const stored = readOpenFiles(runId)

    return initialPath ? withOpened(stored, initialPath) : stored
  })

  const [treeShown, setTreeShown] = useState(true)
  const [searching, setSearching] = useState(false)

  // The search opens when the pane asks for it: on a new request, or when this tab was only
  // just created by one. Adjusted during render, the way React asks for state derived from props.
  const [seenSearch, setSeenSearch] = useState(() =>
    Date.now() - searchToken < SEARCH_REQUEST_FRESH_MS ? 0 : searchToken,
  )

  if (seenSearch !== searchToken) {
    setSeenSearch(searchToken)
    setSearching(true)
  }

  const [containerRef, bucket] = useWidthBucket<HTMLDivElement>([SIDE_BY_SIDE_PX])
  const sideBySide = bucket > 0

  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey(runId), JSON.stringify(open))
    } catch {
      // Storage is unavailable; the open files last until the page reloads.
    }
  }, [runId, open])

  const repos = useMemo(() => workspace?.repos ?? [], [workspace])
  const changes = changeCount(repos)

  // Starts on what the session has done when it has done anything, and on everything otherwise.
  const shown: WorkspaceFilter = filter ?? (changes > 0 ? 'changed' : 'all')
  const tree = useMemo(() => workspaceTree(repos, shown), [repos, shown])
  const paths = useMemo(() => workspaceFiles(repos), [repos])
  const openFolders = expanded ?? initiallyExpanded(tree)

  if (error && !workspace) {
    return (
      <EmptyState icon={<Files />} title="Workspace unavailable">
        {error.message}
      </EmptyState>
    )
  }

  if (!workspace) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-xs">
        Loading the workspace…
      </div>
    )
  }

  const empty = paths.length === 0 && changes === 0

  const openFile = (path: string) => {
    if (
      unsaved &&
      path !== open.active &&
      !window.confirm('Discard your unsaved edit to this file?')
    ) {
      return
    }

    setUnsaved(false)
    setOpen((current) => withOpened(current, path))

    // With room for only one of them, picking a file moves to it.
    if (!sideBySide) {
      setTreeShown(false)
    }
  }

  const toggle = (path: string) => {
    const next = new Set(openFolders)

    if (next.has(path)) {
      next.delete(path)
    } else {
      next.add(path)
    }

    setExpanded(next)
  }

  // One repository needs no heading of its own in the tree: the bar above already names it.
  const single = repos.length === 1 ? repos[0] : undefined
  const roots = single ? (tree[0]?.children ?? []) : tree

  const explorer = (
    <div className="flex h-full min-h-0 flex-col">
      <button
        type="button"
        onClick={() => setSearching(true)}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex h-8 shrink-0 items-center gap-1.5 border-b px-2.5 text-left text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-inset"
      >
        <Search className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">Go to file…</span>
        <Kbd>{quickOpenShortcut()}</Kbd>
      </button>
      <ScrollArea className="min-h-0 flex-1">
        {roots.length === 0 || (shown === 'changed' && changes === 0) ? (
          <p className="text-muted-foreground px-3 py-4 text-[12px] leading-relaxed text-pretty">
            {shown === 'changed'
              ? 'Nothing has changed since the session started.'
              : 'No files yet. They appear here as agents write them.'}
          </p>
        ) : (
          <ul className="py-1.5 text-[12px]" role="tree" aria-label="Workspace files">
            {roots.map((node) => (
              <TreeNode
                key={node.path}
                node={node}
                depth={0}
                repos={repos}
                runId={runId}
                expanded={openFolders}
                activePath={open.active}
                onToggle={toggle}
                onOpenFile={openFile}
              />
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  )

  const active = open.active

  // An edit in progress is not thrown away by moving to another file without being asked.
  const leaving = (go: () => void) => {
    if (!unsaved || window.confirm('Discard your unsaved edit to this file?')) {
      setUnsaved(false)
      go()
    }
  }

  const editBlock =
    workspace.source !== 'sandbox'
      ? 'A saved copy cannot be edited. Send a message to wake the sandbox.'
      : workspace.working
        ? 'Agents are working. Edit once they have finished.'
        : null

  const contents = (
    <div className="bg-background flex h-full min-h-0 min-w-0 flex-col">
      <OpenFileStrip
        open={open}
        treeShown={treeShown}
        onToggleTree={() => setTreeShown((isShown) => !isShown)}
        onSelect={(path) => leaving(() => setOpen((current) => ({ ...current, active: path })))}
        onClose={(path) =>
          path === open.active
            ? leaving(() => setOpen((current) => withClosed(current, path)))
            : setOpen((current) => withClosed(current, path))
        }
      />
      <div className="min-h-0 flex-1">
        {active ? (
          <Suspense
            fallback={
              <div className="text-muted-foreground flex h-full items-center justify-center text-xs">
                Loading…
              </div>
            }
          >
            <FilePane
              key={active}
              runId={runId}
              path={active}
              status={changeAt(repos, active)}
              editBlock={editBlock}
              onDirtyChange={setUnsaved}
            />
          </Suspense>
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
      <WorkspaceBar
        workspace={workspace}
        runId={runId}
        single={single}
        changes={changes}
        filter={shown}
        onFilter={(next) => {
          setFilter(next)
          setExpanded(null)
        }}
      />
      {workspace.strays.map((stray) => (
        <StrayNotice key={stray.path} runId={runId} stray={stray} />
      ))}
      <FileQuickOpen
        open={searching}
        onOpenChange={setSearching}
        paths={paths}
        recent={open.paths}
        onPick={openFile}
      />
      <div className="min-h-0 flex-1">
        {empty ? (
          <EmptyState icon={<Files />} title="Nothing here yet">
            {workspace.source === 'asleep'
              ? 'The sandbox for this session is asleep and no saved copy exists yet. Send a message to wake it.'
              : 'Files appear here as agents write them.'}
          </EmptyState>
        ) : sideBySide && treeShown ? (
          <ResizablePanelGroup orientation="horizontal">
            <ResizablePanel id="file-contents" minSize={200}>
              {contents}
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel id="file-tree" defaultSize="34" minSize={130} maxSize="60">
              {explorer}
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

/** A two- or three-way switch drawn as one control. */
function Segmented<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: T
  onChange: (value: T) => void
  options: readonly { readonly value: T; readonly label: string; readonly count?: number }[]
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="ml-auto flex shrink-0 rounded-md border p-px"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            'focus-visible:ring-ring/50 flex h-[18px] items-center gap-1 rounded-[5px] px-1.5 text-[11px] outline-none focus-visible:ring-2',
            option.value === value
              ? 'bg-accent text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {option.label}
          {option.count ? <span className="tabular-nums opacity-70">{option.count}</span> : null}
        </button>
      ))}
    </div>
  )
}

/**
 * The line under the tabs: whether this is the live workspace or a saved copy, whose sandbox it
 * is in when that is not yours, the repository when there is only one, and the filter.
 */
function WorkspaceBar({
  workspace,
  runId,
  single,
  changes,
  filter,
  onFilter,
}: {
  workspace: SandboxWorkspace
  runId: string
  single: WorkspaceRepo | undefined
  changes: number
  filter: WorkspaceFilter
  onFilter: (filter: WorkspaceFilter) => void
}) {
  const now = useNow()
  const me = useTenant().user.id
  const people = useOrgPeople()
  const holder = workspace.holderId && workspace.holderId !== me ? workspace.holderId : null

  const state =
    workspace.source === 'saved'
      ? workspace.savedAt
        ? `Saved ${relativeTime(workspace.savedAt, now)}`
        : 'Saved copy'
      : workspace.source === 'asleep'
        ? 'Asleep'
        : holder
          ? `Live · ${people.get(holder) ?? 'a teammate'}`
          : 'Live'

  const explained =
    workspace.source === 'saved'
      ? `The sandbox is asleep. This is the work as it was last saved${workspace.savedAt ? `, ${fullDateTime(workspace.savedAt)}` : ''}.`
      : workspace.source === 'asleep'
        ? 'The sandbox is asleep and nothing has been saved yet.'
        : holder
          ? `Read live from ${people.get(holder) ?? 'a teammate'}'s sandbox, where the session is working.`
          : 'Read live from the sandbox the session is working in.'

  return (
    <div className="text-muted-foreground flex h-8 shrink-0 items-center gap-2 border-b px-2.5 text-[11px]">
      <span className="flex shrink-0 items-center gap-1.5" title={explained}>
        {workspace.source === 'sandbox' ? (
          <span aria-hidden className="bg-status-completed size-1.5 rounded-full" />
        ) : (
          <Moon aria-hidden className="size-3" />
        )}
        <span className="text-foreground font-medium">{state}</span>
      </span>
      {single ? <RepoFacts repo={single} runId={runId} /> : null}
      <Segmented
        label="Files to show"
        value={filter}
        onChange={onFilter}
        options={[
          { value: 'all', label: 'All' },
          { value: 'changed', label: 'Changed', count: changes },
        ]}
      />
    </div>
  )
}

/** A repository's name, the branch its changes are measured from, and its pull requests. */
function RepoFacts({
  repo,
  runId,
  counted,
}: {
  repo: WorkspaceRepo
  runId: string
  counted?: boolean
}) {
  const inbox = useProjection(useRunStore(usePullsRunId()), pullInbox)

  const pulls = repo.fullName
    ? authoredPullsForSession(inbox, runId).filter((pull) => pull.fullName === repo.fullName)
    : []

  // A review session has a pull request checked out, not a branch cut from the default one.
  const reviewed = reviewedPullForSession(inbox, runId)
  const reviewing = repo.fullName && reviewed?.fullName === repo.fullName ? reviewed : undefined
  const Icon = repo.fullName ? GitBranch : Package

  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Icon aria-hidden className="size-3 shrink-0" />
      <span className="text-foreground min-w-0 truncate" title={repoLabel(repo)}>
        {repoLabel(repo)}
      </span>
      {reviewing ? (
        <span
          className="flex min-w-0 items-center gap-1"
          title={`Pull request ${reviewing.number}: ${reviewing.title}\nChecked out at ${reviewing.headRef}. Changes are measured from ${reviewing.baseRef}.`}
        >
          <GitPullRequest aria-hidden className="size-3 shrink-0" />
          <span className="shrink-0 tabular-nums">{reviewing.number}</span>
          <span className="min-w-0 truncate">
            {reviewing.headRef} → {reviewing.baseRef}
          </span>
        </span>
      ) : repo.fullName ? (
        <span className="shrink-0" title={`Changes are measured from ${repo.defaultBranch}`}>
          {repo.defaultBranch}
        </span>
      ) : (
        <span
          className="shrink-0"
          title="This folder has no repository linked, so the work is not on GitHub."
        >
          not on GitHub
        </span>
      )}
      {counted && repo.changes.length > 0 ? (
        <span className="text-foreground shrink-0 tabular-nums">+{repo.changes.length}</span>
      ) : null}
      {pulls.map((pull) =>
        // Inside a tree row, which is itself a button, the number is shown but is not a link.
        counted ? (
          <span key={pull.number} className="flex shrink-0 items-center gap-0.5">
            <GitPullRequest aria-hidden className="size-3" />
            {pull.number}
          </span>
        ) : (
          <a
            key={pull.number}
            href={pull.url}
            target="_blank"
            rel="noreferrer"
            className="hover:text-foreground focus-visible:ring-ring/50 flex shrink-0 items-center gap-0.5 rounded-sm outline-none focus-visible:ring-2"
            title={`Pull request ${pull.number}${pull.draft ? ' (draft)' : ''}`}
          >
            <GitPullRequest aria-hidden className="size-3" />
            {pull.number}
          </a>
        ),
      )}
    </span>
  )
}

/** Says an agent left work outside the workspace, where nobody else can see it, and offers to move it in. */
function StrayNotice({
  runId,
  stray,
}: {
  runId: string
  stray: { readonly path: string; readonly files: number }
}) {
  const host = useShuttleHost()
  const api = useApi()
  const queryClient = useQueryClient()

  // What was moved in shows up among the workspace's files, and the notice about it goes.
  const adopt = useMutation(
    api.sandbox.adopt.mutationOptions({
      onSuccess: () => invalidateWorktree(host, queryClient, runId),
    }),
  )

  return (
    <div className="flex shrink-0 items-start gap-2 border-b px-2.5 py-2 text-[11.5px] leading-snug">
      <TriangleAlert aria-hidden className="text-status-waiting mt-px size-3.5 shrink-0" />
      <p className="text-muted-foreground min-w-0 flex-1 text-pretty">
        <span className="text-foreground font-mono">{stray.path}</span> was written outside the
        workspace
        {stray.files > 0 ? ` (${stray.files} ${stray.files === 1 ? 'file' : 'files'})` : ''}, so it
        is not shown, saved or shared.
        {adopt.error ? (
          <span role="alert" className="text-destructive">
            {' '}
            {adopt.error.message}
          </span>
        ) : null}
      </p>
      <Button
        variant="outline"
        size="sm"
        className="h-6 shrink-0 px-2 text-[11px]"
        disabled={adopt.isPending}
        onClick={() => adopt.mutate({ id: runId, path: stray.path })}
      >
        {adopt.isPending ? 'Moving…' : 'Move in'}
      </Button>
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
  const stripRef = useRef<HTMLDivElement>(null)

  // Keeps the file in view in the strip when it is picked from the tree or the search.
  useEffect(() => {
    if (open.active) {
      stripRef.current
        ?.querySelector(`[data-path="${CSS.escape(open.active)}"]`)
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }, [open.active])

  // Two open files with the same name are told apart by their folder.
  const names = open.paths.map((path) => path.split('/').pop() ?? path)

  return (
    <div ref={stripRef} className="flex h-8 shrink-0 items-stretch border-b">
      <ScrollArea
        horizontal
        vertical={false}
        barClassName="h-1.5"
        className="min-w-0 flex-1"
        viewportClassName="[&>div]:flex! [&>div]:h-8 [&>div]:w-max [&>div]:items-stretch"
      >
        {open.paths.map((path, index) => {
          const active = path === open.active
          const name = names[index] ?? path
          const twin = names.indexOf(name) !== names.lastIndexOf(name)
          const folder = path.split('/').slice(-2, -1)[0]

          return (
            <div
              key={path}
              data-path={path}
              role="presentation"
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
      </ScrollArea>
      <button
        type="button"
        onClick={onToggleTree}
        aria-label={treeShown ? 'Hide file tree' : 'Show file tree'}
        aria-pressed={treeShown}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex w-8 shrink-0 items-center justify-center border-l outline-none focus-visible:ring-2 focus-visible:ring-inset"
      >
        <PanelRight className="size-3.5" />
      </button>
    </div>
  )
}

function TreeNode({
  node,
  depth,
  repos,
  runId,
  expanded,
  activePath,
  onToggle,
  onOpenFile,
}: {
  node: WorkspaceNode
  depth: number
  repos: readonly WorkspaceRepo[]
  runId: string
  expanded: ReadonlySet<string>
  activePath: string | null
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
}) {
  const open = expanded.has(node.path)

  const rowClass =
    'focus-visible:ring-ring/50 flex h-6 w-full items-center gap-1.5 pr-2.5 text-left outline-none transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-inset'

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
          <span className={cn('min-w-0 flex-1 truncate', node.status === 'D' && 'line-through')}>
            {node.name}
          </span>
          {node.status ? (
            <span
              className={cn('shrink-0 font-mono text-[10.5px]', STATUS_CLASS[node.status])}
              title={STATUS_LABEL[node.status]}
            >
              {node.status}
            </span>
          ) : null}
        </button>
      </li>
    )
  }

  const repo = node.kind === 'repo' ? repos.find((item) => item.name === node.name) : undefined
  const FolderIcon = open ? FolderOpen : Folder

  return (
    <li role="treeitem" aria-expanded={open}>
      <button
        type="button"
        onClick={() => onToggle(node.path)}
        className={cn(
          rowClass,
          'hover:bg-accent/50',
          repo && 'text-muted-foreground mt-1 h-7 text-[11px] first:mt-0',
        )}
        style={{ paddingLeft: 8 + depth * 12 }}
        title={node.path}
      >
        <ChevronRight
          className={cn(
            'text-muted-foreground size-3 shrink-0 transition-transform duration-100',
            open && 'rotate-90',
          )}
        />
        {repo ? (
          <RepoFacts repo={repo} runId={runId} counted />
        ) : (
          <>
            <FolderIcon className="text-muted-foreground size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{node.name}</span>
            {node.changed > 0 ? (
              <span aria-hidden className="bg-status-waiting size-1.5 shrink-0 rounded-full" />
            ) : null}
          </>
        )}
      </button>
      {open ? (
        <ul role="group">
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              repos={repos}
              runId={runId}
              expanded={expanded}
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

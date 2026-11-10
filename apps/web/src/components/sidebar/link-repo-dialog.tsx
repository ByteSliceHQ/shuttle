import { Check, GitBranch, LoaderCircle, Lock, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { RepoName } from '@/components/sidebar/repo-chip'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/cn'
import {
  linkFolderRepos,
  searchGithubRepos,
  type LinkedRepo,
  type WorkspaceTree,
} from '@/lib/workspace'

function linkLabel(count: number): string {
  if (count === 0) {
    return 'Link'
  }

  return count === 1 ? 'Link 1 repository' : `Link ${count} repositories`
}

export function LinkRepoDialog({
  open,
  onOpenChange,
  folderId,
  folderName,
  tree,
  linked,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  folderId: string
  folderName: string
  tree: WorkspaceTree
  linked: readonly LinkedRepo[]
}) {
  const hasInstall = Object.keys(tree.installations).length > 0
  const [query, setQuery] = useState('')
  const [repos, setRepos] = useState<LinkedRepo[]>([])
  const [selected, setSelected] = useState<Record<string, LinkedRepo>>({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const linkedNames = useMemo(
    () => new Set(linked.map((repo) => repo.fullName.toLowerCase())),
    [linked],
  )

  useEffect(() => {
    if (!open || !hasInstall) {
      return
    }

    const handle = window.setTimeout(() => {
      setLoading(true)

      void searchGithubRepos(query)
        .then(setRepos)
        .catch(() => setRepos([]))
        .finally(() => setLoading(false))
    }, 200)

    return () => window.clearTimeout(handle)
  }, [open, query, hasInstall])

  function handleOpenChange(next: boolean) {
    if (!next) {
      setQuery('')
      setSelected({})
      setError(null)
    }

    onOpenChange(next)
  }

  async function save() {
    const picks = Object.values(selected)

    if (picks.length === 0) {
      handleOpenChange(false)
      return
    }

    setSaving(true)
    setError(null)

    try {
      await linkFolderRepos(
        folderId,
        picks.map((repo) => ({
          installationId: repo.installationId,
          owner: repo.owner,
          name: repo.name,
        })),
      )

      handleOpenChange(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to link repositories')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Link repositories</DialogTitle>
          <DialogDescription>
            Agents spawned in{' '}
            <span className="text-foreground wrap-anywhere" dir="auto">
              {folderName}
            </span>{' '}
            get worktrees of every linked repo.
          </DialogDescription>
        </DialogHeader>

        {!hasInstall ? (
          <div className="bg-card/50 flex flex-col items-start gap-3 rounded-lg border border-dashed p-4">
            <p className="text-muted-foreground text-xs leading-relaxed">
              Connect a GitHub App installation to browse repositories you can link.
            </p>
            <Button variant="brand" size="sm" asChild>
              <a href="/github/install">
                <GitBranch />
                Connect GitHub
              </a>
            </Button>
          </div>
        ) : (
          <>
            <div className="relative">
              <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
              <Input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search repositories…"
                className="pr-8 pl-8"
                aria-label="Search repositories"
              />
              {loading ? (
                <LoaderCircle className="text-muted-foreground absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 animate-spin" />
              ) : null}
            </div>
            <ul
              className={cn(
                'h-64 overflow-y-auto overscroll-contain rounded-lg border transition-opacity duration-150',
                loading && repos.length > 0 && 'opacity-60',
              )}
            >
              {repos.length === 0 ? (
                <li className="text-muted-foreground flex h-full items-center justify-center px-3 text-center text-xs">
                  {loading
                    ? 'Searching…'
                    : query
                      ? `No repositories match “${query}”.`
                      : 'No repositories found.'}
                </li>
              ) : (
                repos.map((repo) => {
                  const already = linkedNames.has(repo.fullName.toLowerCase())
                  const checked = already || Boolean(selected[repo.fullName])

                  return (
                    <li key={repo.fullName}>
                      <button
                        type="button"
                        disabled={already}
                        onClick={() =>
                          setSelected((prev) => {
                            if (prev[repo.fullName]) {
                              const next = { ...prev }
                              delete next[repo.fullName]
                              return next
                            }

                            return { ...prev, [repo.fullName]: repo }
                          })
                        }
                        role="checkbox"
                        aria-checked={checked}
                        className={cn(
                          'hover:bg-accent/60 flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors duration-100',
                          checked && 'bg-accent/40',
                          already && 'opacity-60',
                        )}
                      >
                        <span
                          className={cn(
                            'flex size-4 shrink-0 items-center justify-center rounded border transition-colors duration-100',
                            checked
                              ? 'bg-brand border-brand text-brand-foreground'
                              : 'border-input',
                          )}
                        >
                          {checked ? <Check className="size-3" /> : null}
                        </span>
                        <span className="min-w-0 flex-1">
                          <RepoName repo={repo} className="text-[13px]" />
                          <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-[11px]">
                            {repo.private ? (
                              <Lock className="size-3 shrink-0" aria-label="Private" />
                            ) : null}
                            <span className="truncate font-mono text-[10px]">
                              {repo.defaultBranch}
                            </span>
                            {already ? <span className="shrink-0">· Linked</span> : null}
                          </span>
                        </span>
                      </button>
                    </li>
                  )
                })
              )}
            </ul>
          </>
        )}

        {error ? <p className="text-status-failed text-xs">{error}</p> : null}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          {hasInstall ? (
            <Button
              variant="brand"
              size="sm"
              disabled={saving || Object.keys(selected).length === 0}
              onClick={() => void save()}
            >
              {saving ? <LoaderCircle className="animate-spin" /> : null}
              {linkLabel(Object.keys(selected).length)}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

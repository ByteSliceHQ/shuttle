import { Check, GitBranch, LoaderCircle, Lock, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

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
            Agents spawned in <span className="text-foreground">{folderName}</span> get worktrees of
            every linked repo.
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
                className="pl-8"
                aria-label="Search repositories"
              />
            </div>
            <ul className="max-h-64 overflow-y-auto rounded-lg border">
              {loading ? (
                <li className="text-muted-foreground flex items-center gap-2 px-3 py-6 text-xs">
                  <LoaderCircle className="size-3.5 animate-spin" />
                  Searching…
                </li>
              ) : repos.length === 0 ? (
                <li className="text-muted-foreground px-3 py-6 text-center text-xs">
                  No repositories found.
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
                        className={cn(
                          'hover:bg-accent/60 flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors',
                          checked && 'bg-accent/40',
                          already && 'opacity-60',
                        )}
                      >
                        <span
                          className={cn(
                            'flex size-4 items-center justify-center rounded border',
                            checked
                              ? 'bg-brand border-brand text-brand-foreground'
                              : 'border-input',
                          )}
                        >
                          {checked ? <Check className="size-3" /> : null}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px]">{repo.fullName}</span>
                          <span className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
                            {repo.private ? <Lock className="size-3" /> : null}
                            {repo.defaultBranch}
                            {already ? <span>· Linked</span> : null}
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
              Link {Object.keys(selected).length || ''}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

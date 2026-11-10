import { GitBranch, Lock, X } from 'lucide-react'

import { cn } from '@/lib/cn'
import type { LinkedRepo } from '@/lib/workspace'

type RepoSummary = Pick<LinkedRepo, 'owner' | 'name' | 'fullName' | 'private' | 'defaultBranch'>

const OWNER_MAX = 14

function shortOwner(owner: string): string {
  const chars = Array.from(owner)
  return chars.length > OWNER_MAX ? `${chars.slice(0, OWNER_MAX - 2).join('')}…` : owner
}

/** Repos sharing an org differ at the end, so the owner is shortened before the name is. */
export function RepoName({ repo, className }: { repo: RepoSummary; className?: string }) {
  return (
    <span className={cn('flex min-w-0 items-baseline', className)} title={repo.fullName}>
      <span className="text-muted-foreground shrink-0">{shortOwner(repo.owner)}/</span>
      <span className="text-foreground min-w-0 truncate">{repo.name}</span>
    </span>
  )
}

export function RepoChip({
  repo,
  onRemove,
  className,
}: {
  repo: RepoSummary
  onRemove?: () => void
  className?: string
}) {
  return (
    <span
      className={cn(
        'bg-card/60 text-muted-foreground group/chip inline-flex h-6 max-w-64 min-w-0 items-center gap-1.5 rounded-full border pr-1 pl-2.5 text-[11px]',
        !onRemove && 'pr-2.5',
        className,
      )}
    >
      <GitBranch className="size-3 shrink-0" />
      <RepoName repo={repo} />
      {repo.private ? <Lock className="size-3 shrink-0" aria-label="Private" /> : null}
      <span className="max-w-24 shrink-0 truncate font-mono text-[10px]" title={repo.defaultBranch}>
        {repo.defaultBranch}
      </span>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Unlink ${repo.fullName}`}
          className="hover:bg-accent hover:text-foreground flex size-4 shrink-0 items-center justify-center rounded-full opacity-0 transition-opacity duration-100 group-hover/chip:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
        >
          <X className="size-3" />
        </button>
      ) : null}
    </span>
  )
}

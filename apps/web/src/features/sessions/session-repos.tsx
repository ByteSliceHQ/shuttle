import { Link } from '@tanstack/react-router'
import { ArrowRight, ChevronDown, ExternalLink, GitBranch, Lock } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { RepoName } from '@/features/workspace/repo-chip'
import { repoCountLabel, type LinkedRepo } from '@/features/workspace/workspace'

/** One trigger for every linked repo, so its width doesn't grow with the folder. */
export function SessionRepos({
  folderId,
  folderName,
  repos,
  align = 'end',
}: {
  folderId: string
  folderName: string
  repos: readonly LinkedRepo[]
  align?: 'start' | 'end'
}) {
  const [first] = repos

  if (!first) {
    return null
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="data-[state=open]:bg-accent data-[state=open]:text-foreground max-w-44"
          aria-label={`${repoCountLabel(repos.length)} in ${folderName}`}
        >
          <GitBranch />
          <span className="hidden min-w-0 truncate md:inline">
            {repos.length === 1 ? first.name : `${repos.length.toLocaleString()} repos`}
          </span>
          <span className="tabular-nums md:hidden">{repos.length.toLocaleString()}</span>
          <ChevronDown className="opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align={align} collisionPadding={12} className="w-80">
        <div className="flex items-baseline gap-2 border-b px-3 py-2.5">
          <span className="text-[12px] font-medium">Repositories</span>
          <span className="text-muted-foreground font-mono text-[11px] tabular-nums">
            {repos.length.toLocaleString()}
          </span>
          <span
            className="text-muted-foreground ml-auto min-w-0 truncate text-[11px]"
            dir="auto"
            title={folderName}
          >
            {folderName}
          </span>
        </div>
        <ul className="max-h-72 overflow-y-auto overscroll-contain p-1">
          {repos.map((repo) => (
            <li key={repo.fullName}>
              <a
                href={`https://github.com/${repo.fullName}`}
                target="_blank"
                rel="noreferrer"
                className="hover:bg-accent focus-visible:bg-accent group/repo flex h-8 items-center gap-2 rounded-md px-2 text-[12px] transition-colors duration-100 outline-none"
              >
                <RepoName repo={repo} className="flex-1" />
                {repo.private ? (
                  <Lock className="text-muted-foreground size-3 shrink-0" aria-label="Private" />
                ) : null}
                <span
                  className="text-muted-foreground max-w-20 shrink-0 truncate font-mono text-[10px]"
                  title={repo.defaultBranch}
                >
                  {repo.defaultBranch}
                </span>
                <ExternalLink className="text-muted-foreground size-3 shrink-0 opacity-0 transition-opacity duration-100 group-hover/repo:opacity-100 group-focus-visible/repo:opacity-100" />
              </a>
            </li>
          ))}
        </ul>
        <div className="border-t p-1">
          <Link
            to="/folders/$folderId"
            params={{ folderId }}
            className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:bg-accent flex h-8 items-center gap-2 rounded-md px-2 text-[12px] transition-colors duration-100 outline-none"
          >
            Manage repos
            <ArrowRight className="ml-auto size-3.5" />
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  )
}

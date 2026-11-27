import { ChevronDown, ExternalLink, Folder as FolderIcon, GitBranch, Lock } from 'lucide-react'

import { Button } from '../../components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover'
import { Link } from '../../shuttle'
import { RepoName } from '../workspace/repo-chip'
import type { LinkedRepo } from '../workspace/workspace'

function triggerLabel(count: number): string {
  return count === 1
    ? '1 repository in this session'
    : `${count.toLocaleString()} repositories in this session`
}

/**
 * The repositories the session started with, behind one trigger so its width doesn't grow with
 * them. They are read only: a session keeps the ones it started with, and linking is done on
 * the folder, for the sessions started after.
 */
export function SessionRepos({
  repos,
  folder,
  align = 'end',
}: {
  /** The session's own repositories, not its folder's as they are now. */
  repos: readonly LinkedRepo[]
  /** The session's folder, where what hosts it keeps folders. */
  folder?: { readonly folderId: string; readonly name: string }
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
          aria-label={triggerLabel(repos.length)}
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
          {folder ? (
            <Link
              to={{ page: 'folder', folderId: folder.folderId }}
              title={folder.name}
              className="text-muted-foreground hover:text-foreground focus-visible:text-foreground ml-auto inline-flex min-w-0 items-center gap-1.5 self-center rounded-sm text-[11px] transition-colors duration-100 outline-none"
            >
              <FolderIcon className="size-3 shrink-0" />
              <span className="truncate" dir="auto">
                {folder.name}
              </span>
            </Link>
          ) : null}
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
        <p className="text-muted-foreground border-t px-3 py-2 text-[11px]">
          Set when this session started
        </p>
      </PopoverContent>
    </Popover>
  )
}

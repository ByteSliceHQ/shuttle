import { Bot, ExternalLink, GitPullRequest, Layers } from 'lucide-react'
import { Fragment } from 'react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu'
import { cn } from '../../lib/cn'
import { RepoDot, repoShortName } from '../pulls/pull-glyphs'
import { groupSessionPulls } from '../pulls/session-pull-groups'
import type { PublishedPull } from './session-feed'

const STACKED_DOTS = 4

function PullRow({ pull, layer }: { pull: PublishedPull; layer?: number }) {
  return (
    <DropdownMenuItem asChild>
      <a href={pull.url} target="_blank" rel="noreferrer" title={pull.fullName}>
        {layer !== undefined ? (
          <span className="text-muted-foreground w-4 shrink-0 text-center text-[10px] tabular-nums">
            {layer}
          </span>
        ) : (
          <RepoDot fullName={pull.fullName} />
        )}
        <span className="min-w-0 truncate">{repoShortName(pull.fullName)}</span>
        <span className="text-muted-foreground shrink-0 font-mono">#{pull.number}</span>
        {pull.draft ? (
          <span className="text-muted-foreground shrink-0 rounded border border-dashed px-1 text-[9px] uppercase">
            Draft
          </span>
        ) : null}
        <ExternalLink className="text-muted-foreground ml-auto" />
      </a>
    </DropdownMenuItem>
  )
}

/** One header pill for every PR this session opened; the menu groups stacks and standalone PRs. */
export function SessionPrPills({
  pulls,
  labelFor,
  onInspect,
}: {
  pulls: readonly PublishedPull[]
  labelFor: (threadId: string | null) => string | undefined
  onInspect: (threadId: string) => void
}) {
  const first = pulls[0]

  if (!first) {
    return null
  }

  const single = pulls.length === 1
  const { stacks, standalone } = groupSessionPulls(pulls)
  const onlyStack = stacks.length === 1 && standalone.length === 0 ? stacks[0] : undefined
  const allDraft = pulls.every((pull) => pull.draft)
  const repos = [...new Set(pulls.map((pull) => pull.fullName))]
  const multiRepo = repos.length > 1

  const openers = [
    ...new Set(pulls.flatMap((pull) => (pull.threadId !== undefined ? [pull.threadId] : []))),
  ]

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        title={
          single
            ? `${first.fullName}#${first.number}`
            : pulls.map((pull) => `${pull.fullName}#${pull.number}`).join('\n')
        }
        className={cn(
          'text-muted-foreground hover:text-foreground data-[state=open]:text-foreground data-[state=open]:bg-accent inline-flex max-w-44 shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-colors duration-100 outline-none',
          allDraft && 'border-dashed',
        )}
      >
        {stacks.length > 0 ? (
          <Layers className="size-3 shrink-0" />
        ) : (
          <GitPullRequest className="size-3 shrink-0" />
        )}
        {single ? (
          <>
            <span className="min-w-0 truncate font-mono">
              {repoShortName(first.fullName)}#{first.number}
            </span>
            {first.draft ? <span className="text-[9px] uppercase opacity-70">draft</span> : null}
          </>
        ) : onlyStack ? (
          <span className="tabular-nums">Stack · {pulls.length}</span>
        ) : (
          <>
            {multiRepo ? (
              <span aria-hidden className="flex items-center">
                {repos.slice(0, STACKED_DOTS).map((fullName) => (
                  <RepoDot
                    key={fullName}
                    fullName={fullName}
                    className="ring-background -ml-0.5 size-2 ring-2 first:ml-0"
                  />
                ))}
              </span>
            ) : null}
            <span className="tabular-nums">{pulls.length} PRs</span>
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        {single ? (
          <>
            <DropdownMenuLabel>Pull request</DropdownMenuLabel>
            <PullRow pull={first} />
          </>
        ) : (
          <>
            {stacks.map((stack, index) => (
              <Fragment key={stack.key}>
                {index > 0 ? <DropdownMenuSeparator /> : null}
                <>
                  <DropdownMenuLabel>
                    Stack · {stack.layers.length}
                    {multiRepo ? ` · ${repoShortName(stack.fullName)}` : ''}
                  </DropdownMenuLabel>
                  {stack.layers.map((pull) => (
                    <PullRow key={pull.number} pull={pull} layer={pull.stack?.layer} />
                  ))}
                </>
              </Fragment>
            ))}
            {standalone.length > 0 ? (
              <>
                {stacks.length > 0 ? <DropdownMenuSeparator /> : null}
                <>
                  <DropdownMenuLabel>
                    {stacks.length > 0 ? 'Standalone' : `${pulls.length} pull requests`}
                  </DropdownMenuLabel>
                  {standalone.map((pull) => (
                    <PullRow key={`${pull.fullName}#${pull.number}`} pull={pull} />
                  ))}
                </>
              </>
            ) : null}
          </>
        )}
        {openers.length > 0 ? <DropdownMenuSeparator /> : null}
        {openers.map((threadId) => (
          <DropdownMenuItem key={threadId} onSelect={() => onInspect(threadId)}>
            <Bot />
            <span className="truncate">Opened by {labelFor(threadId) ?? 'Agent'}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

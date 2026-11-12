import { ExternalLink, Layers } from 'lucide-react'

import { cn } from '../../lib/cn'
import { laneForPull, type PullInboxSummary, type PullStack } from '../../lib/pulls'
import { CheckGlyph, RepoDot, repoShortName } from './pull-glyphs'

const LANE_LABEL: Record<string, string> = {
  needs_review: 'Needs review',
  reviewing: 'Reviewing',
  changes_requested: 'Changes requested',
  ready: 'Ready',
  drafts: 'Drafts',
  opened_by_shuttle: 'Opened by Shuttle',
}

export function StackLadder({
  stack,
  highlight,
  ghostOutsideLane,
  onOpenPull,
  className,
}: {
  stack: PullStack
  highlight?: PullInboxSummary
  /** Layers not in this set render as compact ghost rows (lane label). */
  ghostOutsideLane?: ReadonlySet<string>
  onOpenPull?: (pull: PullInboxSummary) => void
  className?: string
}) {
  // Top of stack first for the visual ladder.
  const topFirst = [...stack.layers].toReversed()

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
        <Layers className="size-3.5 shrink-0" />
        <span className="text-foreground/90 font-medium">
          Stack · {repoShortName(stack.fullName)}
          {stack.number != null ? ` #${stack.number}` : ''}
        </span>
        <span className="ml-auto tabular-nums">{stack.layers.length}</span>
      </div>

      {!stack.native ? (
        <p className="text-status-warning text-[11px] leading-snug">
          Chained by base branch — not a GitHub stack
        </p>
      ) : null}

      <ol className="relative flex flex-col gap-1 pl-3">
        <span aria-hidden className="bg-border absolute top-2 bottom-2 left-[5px] w-px" />
        {topFirst.map((pull) => {
          const key = `${pull.fullName}#${pull.number}`
          const ghost = ghostOutsideLane != null && !ghostOutsideLane.has(key)

          const active =
            highlight != null &&
            highlight.fullName === pull.fullName &&
            highlight.number === pull.number

          if (ghost) {
            return (
              <li key={key} className="relative flex items-center gap-2 py-0.5 pl-3">
                <span className="bg-border absolute top-1/2 left-[-7px] size-1.5 -translate-y-1/2 rounded-full" />
                <span className="text-muted-foreground truncate text-[11px]">
                  #{pull.number} · in {LANE_LABEL[laneForPull(pull)] ?? laneForPull(pull)}
                </span>
              </li>
            )
          }

          const row = (
            <>
              <span className="bg-foreground/40 absolute top-1/2 left-[-7px] size-1.5 -translate-y-1/2 rounded-full" />
              <RepoDot fullName={pull.fullName} className="size-2.5 shrink-0" />
              <span className="text-muted-foreground shrink-0 tabular-nums">#{pull.number}</span>
              <span className="min-w-0 flex-1 truncate">{pull.title}</span>
              {pull.draft ? (
                <span className="text-muted-foreground shrink-0 text-[10px] uppercase">Draft</span>
              ) : null}
              <CheckGlyph rollup={pull.checkRollup} className="size-3.5 shrink-0" />
              <a
                href={pull.url}
                target="_blank"
                rel="noreferrer"
                className="text-muted-foreground hover:text-foreground shrink-0"
                onClick={(event) => event.stopPropagation()}
              >
                <ExternalLink className="size-3" />
              </a>
            </>
          )

          if (onOpenPull) {
            return (
              <li key={key}>
                <button
                  type="button"
                  onClick={() => onOpenPull(pull)}
                  className={cn(
                    'relative flex w-full items-center gap-2 rounded-md py-1 pl-3 text-left text-[12px]',
                    active ? 'bg-muted/60' : 'hover:bg-muted/40',
                  )}
                >
                  {row}
                </button>
              </li>
            )
          }

          return (
            <li
              key={key}
              className={cn(
                'relative flex items-center gap-2 py-1 pl-3 text-[12px]',
                active && 'bg-muted/60 rounded-md',
              )}
            >
              {row}
            </li>
          )
        })}
      </ol>

      <p className="text-muted-foreground pl-3 text-[11px]">into {stack.baseRef}</p>
    </div>
  )
}

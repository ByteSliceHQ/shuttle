import { CircleCheck, CircleDashed, CircleX } from 'lucide-react'

import { cn } from '@/lib/cn'

import type { CheckRollup, PullLaneId, ReviewDecision } from './pulls'

export function repoShortName(fullName: string): string {
  return fullName.split('/')[1] ?? fullName
}

/** Stable per-repo hue so the same repo reads the same color across rows and sessions. */
export function RepoDot({ fullName, className }: { fullName: string; className?: string }) {
  const hue = [...fullName].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360

  return (
    <span
      aria-hidden
      className={cn('size-1.5 shrink-0 rounded-full', className)}
      style={{ background: `oklch(0.72 0.12 ${hue})` }}
    />
  )
}

export function checkLabel(rollup: CheckRollup): string {
  switch (rollup) {
    case 'passing':
      return 'Checks passing'
    case 'failing':
      return 'Checks failing'
    case 'pending':
      return 'Checks running'
    case 'neutral':
      return 'No checks'

    default: {
      const exhaustive: never = rollup
      return exhaustive
    }
  }
}

export function CheckGlyph({ rollup, className }: { rollup: CheckRollup; className?: string }) {
  const label = checkLabel(rollup)
  const base = cn('size-3 shrink-0', className)

  switch (rollup) {
    case 'passing':
      return <CircleCheck aria-label={label} className={cn(base, 'text-status-completed')} />
    case 'failing':
      return <CircleX aria-label={label} className={cn(base, 'text-status-failed')} />
    case 'pending':
      return <CircleDashed aria-label={label} className={cn(base, 'text-status-waiting')} />
    case 'neutral':
      return null

    default: {
      const exhaustive: never = rollup
      return exhaustive
    }
  }
}

export function reviewLabel(decision: ReviewDecision): string | null {
  switch (decision) {
    case 'approved':
      return 'Approved'
    case 'changes_requested':
      return 'Changes requested'
    case 'review_required':
      return 'Review required'
    case 'none':
      return null

    default: {
      const exhaustive: never = decision
      return exhaustive
    }
  }
}

export function DiffStat({
  additions,
  deletions,
  className,
}: {
  additions: number
  deletions: number
  className?: string
}) {
  return (
    <span
      className={cn('inline-flex shrink-0 gap-1 font-mono text-[10px] tabular-nums', className)}
      aria-label={`${additions} additions, ${deletions} deletions`}
    >
      <span className="text-status-completed">+{additions.toLocaleString()}</span>
      <span className="text-status-failed">−{deletions.toLocaleString()}</span>
    </span>
  )
}

/** Five cells split by the add/delete ratio, the way GitHub summarizes a diff. */
export function DiffCells({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions
  const added = total === 0 ? 0 : Math.round((additions / total) * 5)

  return (
    <span aria-hidden className="inline-flex gap-0.5">
      {Array.from({ length: 5 }, (_, index) => (
        <span
          key={index}
          className={cn(
            'size-2 rounded-[2px]',
            total === 0 ? 'bg-muted' : index < added ? 'bg-status-completed' : 'bg-status-failed',
          )}
        />
      ))}
    </span>
  )
}

export function laneTone(lane: PullLaneId): string {
  switch (lane) {
    case 'needs_review':
      return 'bg-brand'
    case 'reviewing':
      return 'bg-status-running breathe'
    case 'changes_requested':
      return 'bg-status-waiting'
    case 'ready':
      return 'bg-status-completed'
    case 'drafts':
    case 'opened_by_shuttle':
      return 'bg-muted-foreground/50'

    default: {
      const exhaustive: never = lane
      return exhaustive
    }
  }
}

import { cn } from '@/lib/cn'

type DotTone = 'failed' | 'done' | 'working' | 'needs_input' | 'idle'

function dotTone(activity: string, status: string): DotTone {
  if (status === 'failed') {
    return 'failed'
  }

  if (status === 'completed' || status === 'cancelled') {
    return 'done'
  }

  if (activity === 'working' || activity === 'needs_input') {
    return activity
  }

  return 'idle'
}

const DOT_LABELS: Record<DotTone, string> = {
  failed: 'Failed',
  done: 'Finished',
  working: 'Working',
  needs_input: 'Needs input',
  idle: 'Idle',
}

function dotClass(tone: DotTone): string {
  switch (tone) {
    case 'failed':
      return 'bg-status-failed'
    case 'done':
      return 'border-muted-foreground/40 border'
    case 'working':
      return 'bg-brand breathe'
    case 'needs_input':
      return 'bg-status-waiting'
    case 'idle':
      return 'border-muted-foreground/50 border'

    default: {
      const exhaustive: never = tone
      return exhaustive
    }
  }
}

export function ActivityDot({
  activity,
  status,
  className,
}: {
  activity: string
  status: string
  className?: string
}) {
  const tone = dotTone(activity, status)

  return (
    <span
      role="img"
      aria-label={DOT_LABELS[tone]}
      title={DOT_LABELS[tone]}
      className={cn('size-1.5 shrink-0 rounded-full', dotClass(tone), className)}
    />
  )
}

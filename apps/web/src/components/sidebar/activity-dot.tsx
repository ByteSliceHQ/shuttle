import { cn } from '@/lib/cn'

export function ActivityDot({ activity, status }: { activity: string; status: string }) {
  if (status === 'failed') {
    return <span className="bg-status-failed size-1.5 shrink-0 rounded-full" title="Failed" />
  }

  if (status === 'completed' || status === 'cancelled') {
    return (
      <span
        className="border-muted-foreground/40 size-1.5 shrink-0 rounded-full border"
        title={status}
      />
    )
  }

  switch (activity) {
    case 'working':
      return (
        <span className="bg-brand size-1.5 shrink-0 animate-pulse rounded-full" title="Working" />
      )
    case 'needs_input':
      return (
        <span className="bg-status-waiting size-1.5 shrink-0 rounded-full" title="Needs input" />
      )
    default:
      return (
        <span
          className="border-muted-foreground/50 size-1.5 shrink-0 rounded-full border"
          title="Idle"
        />
      )
  }
}

export function activityTone(activity: string, status: string): string {
  if (status === 'failed') {
    return 'text-status-failed'
  }

  if (activity === 'working') {
    return 'text-foreground'
  }

  return 'text-muted-foreground'
}

export function SessionRowShell({
  active,
  children,
  className,
}: {
  active?: boolean
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'group float-in flex h-8 items-center gap-2 rounded-md px-2 text-[12.5px] transition-colors duration-150',
        active ? 'bg-accent text-foreground' : 'hover:bg-accent/50 text-muted-foreground',
        className,
      )}
    >
      {children}
    </div>
  )
}

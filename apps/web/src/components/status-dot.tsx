import { cn } from '@/lib/cn'
import { isLive, statusClass, statusDotClass } from '@/lib/status'

/** Live statuses get a soft halo instead of a blink so the tree stays calm while agents work. */
export function StatusDot({ status, className }: { status: string; className?: string }) {
  return (
    <span className={cn('relative inline-flex size-1.5 shrink-0', className)} aria-hidden>
      {isLive(status) ? (
        <span
          className={cn(
            statusDotClass(status),
            'absolute inset-0 size-full animate-ping opacity-60 motion-reduce:animate-none',
          )}
        />
      ) : null}
      <span className={cn(statusDotClass(status), 'relative')} />
    </span>
  )
}

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full bg-current/10 px-2 text-[11px] font-medium',
        statusClass(status),
        className,
      )}
    >
      <StatusDot status={status} />
      {status}
    </span>
  )
}

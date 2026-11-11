import { cn } from '@/lib/cn'
import { statusClass, statusDotClass, statusLabel, statusTone } from '@/lib/status'

/** Thread and header indicator; only genuinely executing work animates. */
export function StatusDot({ status, className }: { status: string; className?: string }) {
  const tone = statusTone(status)

  switch (tone) {
    case 'running':
      return (
        <svg
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden
          className={cn('text-status-running spinner-ring size-3 shrink-0', className)}
        >
          <circle
            cx="8"
            cy="8"
            r="5.5"
            stroke="currentColor"
            strokeOpacity="0.22"
            strokeWidth="1.75"
          />
          <path
            d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
        </svg>
      )

    case 'waiting':
      return (
        <svg
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden
          className={cn('text-status-waiting size-3 shrink-0', className)}
        >
          <circle
            cx="8"
            cy="8"
            r="5.75"
            stroke="currentColor"
            strokeOpacity="0.6"
            strokeWidth="1.5"
          />
          <circle cx="8" cy="8" r="2.65" fill="currentColor" />
        </svg>
      )

    case 'delegating':
      return (
        <span
          aria-hidden
          className={cn(
            'border-status-running/60 inline-block size-2 shrink-0 rounded-full border-[1.5px]',
            className,
          )}
        />
      )

    case 'idle':
      return (
        <span
          aria-hidden
          className={cn(
            'border-muted-foreground/45 inline-block size-2 shrink-0 rounded-full border',
            className,
          )}
        />
      )

    case 'completed':
    case 'failed':
      return <span aria-hidden className={cn(statusDotClass(status), className)} />

    default: {
      const exhaustive: never = tone
      return exhaustive
    }
  }
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
      {statusLabel(status)}
    </span>
  )
}

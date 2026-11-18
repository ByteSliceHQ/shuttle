import { cn } from '../../lib/cn'
import {
  resolveSessionIndicator,
  sessionIndicatorLabel,
  type SessionIndicatorTone,
} from '../sessions/session-activity'

type ActivityDotProps =
  | {
      readonly tone: SessionIndicatorTone
      readonly label?: string
      readonly className?: string
    }
  | {
      readonly tone?: undefined
      readonly activity: string
      readonly status: string
      readonly unread?: boolean
      readonly label?: string
      readonly className?: string
    }

function IndicatorGlyph({ tone }: { readonly tone: SessionIndicatorTone }) {
  switch (tone) {
    case 'starting':
    case 'working':
      return (
        <svg viewBox="0 0 16 16" fill="none" aria-hidden className="text-brand spinner-ring size-3">
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

    case 'needs_input':
      return (
        <svg viewBox="0 0 16 16" fill="none" aria-hidden className="text-status-waiting size-3">
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

    case 'ready':
      return (
        <svg viewBox="0 0 16 16" fill="none" aria-hidden className="text-status-completed size-3">
          <circle
            cx="8"
            cy="8"
            r="5.75"
            stroke="currentColor"
            strokeOpacity="0.55"
            strokeWidth="1.5"
          />
          <path
            d="M5.5 8.1 7.2 9.8 10.6 6.3"
            stroke="currentColor"
            strokeWidth="1.65"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )

    case 'failed':
      return (
        <svg viewBox="0 0 16 16" fill="none" aria-hidden className="text-status-failed size-3">
          <circle
            cx="8"
            cy="8"
            r="5.75"
            stroke="currentColor"
            strokeOpacity="0.6"
            strokeWidth="1.5"
          />
          <path d="M8 5.2v3.3" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" />
          <circle cx="8" cy="10.9" r="0.9" fill="currentColor" />
        </svg>
      )

    case 'idle':
      return (
        <svg
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden
          className="text-muted-foreground/40 size-3"
        >
          <circle cx="8" cy="8" r="4.75" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      )

    case 'completed':
      return (
        <svg
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden
          className="text-muted-foreground/55 size-3"
        >
          <circle
            cx="8"
            cy="8"
            r="5.25"
            stroke="currentColor"
            strokeOpacity="0.5"
            strokeWidth="1.5"
          />
          <path
            d="M5.75 8.1 7.3 9.65 10.4 6.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )

    case 'cancelled':
      return (
        <svg
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden
          className="text-muted-foreground/40 size-3"
        >
          <circle cx="8" cy="8" r="5.25" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M4.5 11.5 11.5 4.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      )

    default: {
      const exhaustive: never = tone
      return exhaustive
    }
  }
}

export function ActivityDot(props: ActivityDotProps) {
  const tone =
    props.tone ??
    resolveSessionIndicator({
      activity: props.activity,
      status: props.status,
      unread: props.unread,
    })

  const label = props.label ?? sessionIndicatorLabel(tone)

  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn('inline-flex size-3.5 shrink-0 items-center justify-center', props.className)}
    >
      <IndicatorGlyph tone={tone} />
    </span>
  )
}

import { cn } from '../lib/cn'

/**
 * The Shuttle mark: two weft threads woven over and under two warp threads. The warp takes the
 * current text color; the weft the shuttle lays is the brand blue.
 */
export function ShuttleMark({ className }: { className?: string }) {
  return (
    <svg viewBox="4 4 40 40" fill="currentColor" aria-hidden className={cn('shrink-0', className)}>
      <g>
        <rect x="11.5" y="5" width="9" height="20.5" rx="2.25" />
        <rect x="11.5" y="38.5" width="9" height="4.5" rx="2.25" />
        <rect x="27.5" y="5" width="9" height="4.5" rx="2.25" />
        <rect x="27.5" y="22.5" width="9" height="20.5" rx="2.25" />
      </g>
      <g className="fill-brand">
        <rect x="5" y="11.5" width="4.5" height="9" rx="2.25" />
        <rect x="22.5" y="11.5" width="20.5" height="9" rx="2.25" />
        <rect x="5" y="27.5" width="20.5" height="9" rx="2.25" />
        <rect x="38.5" y="27.5" width="4.5" height="9" rx="2.25" />
      </g>
    </svg>
  )
}

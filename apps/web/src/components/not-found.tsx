import { Link, useCanGoBack, useLocation, useRouter } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import type { ReactNode } from 'react'

import { Button, cn } from '@shuttle/react/ui'

const PATH_MAX = 60

function displayPath(pathname: string): string {
  let path = pathname

  try {
    path = decodeURIComponent(pathname)
  } catch {
    // keep the raw path when it isn't valid percent-encoding
  }

  const chars = Array.from(path)
  return chars.length > PATH_MAX ? `${chars.slice(0, PATH_MAX - 1).join('')}…` : path
}

export function NotFound({
  eyebrow = '404',
  title,
  children,
}: {
  eyebrow?: string
  title: string
  children: ReactNode
}) {
  const router = useRouter()
  const canGoBack = useCanGoBack()

  return (
    <div className="flex h-full flex-col items-center justify-center overflow-y-auto px-6 py-12 text-center">
      <DroppedStitch className="mb-8 w-32 max-w-full shrink-0 sm:w-36" />
      <div className="stagger flex max-w-sm flex-col items-center">
        <p className="text-muted-foreground font-mono text-[11px] tracking-[0.2em] uppercase">
          {eyebrow}
        </p>
        <h1 className="mt-2 text-xl font-semibold tracking-tight text-balance">{title}</h1>
        <p className="text-muted-foreground mt-2 text-sm leading-relaxed text-pretty">{children}</p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Button variant="brand" size="sm" asChild>
            <Link to="/">Back home</Link>
          </Button>
          {canGoBack ? (
            <Button variant="ghost" size="sm" onClick={() => router.history.back()}>
              <ArrowLeft />
              Go back
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export function RouteNotFound() {
  const pathname = useLocation({ select: (location) => location.pathname })

  return (
    <NotFound title="Dropped a stitch">
      We sent the shuttle to{' '}
      <code className="bg-muted text-foreground rounded px-1 py-0.5 font-mono text-[12px] wrap-anywhere">
        {displayPath(pathname)}
      </code>{' '}
      and it came back with nothing but loose thread. The link may be stale, or it was never woven
      in.
    </NotFound>
  )
}

/** The logo with one pick dropped out of the weave: its place is empty and the bar lies below. */
function DroppedStitch({ className }: { className?: string }) {
  return (
    <svg viewBox="-4 2 56 62" aria-hidden className={cn('overflow-visible', className)}>
      <ellipse cx="19" cy="62" rx="13" ry="1.2" className="fill-foreground/5" />
      <g className="lost-cloth">
        <g className="fill-foreground/85">
          <rect x="11.5" y="5" width="9" height="20.5" rx="2.25" />
          <rect x="11.5" y="38.5" width="9" height="4.5" rx="2.25" />
          <rect x="27.5" y="5" width="9" height="4.5" rx="2.25" />
          <rect x="27.5" y="22.5" width="9" height="20.5" rx="2.25" />
        </g>
        <g className="fill-brand">
          <rect x="5" y="11.5" width="4.5" height="9" rx="2.25" />
          <rect x="22.5" y="11.5" width="20.5" height="9" rx="2.25" />
          <rect x="38.5" y="27.5" width="4.5" height="9" rx="2.25" />
        </g>
        <rect
          x="5.5"
          y="28"
          width="19.5"
          height="8"
          rx="1.75"
          fill="none"
          strokeWidth="0.75"
          strokeDasharray="1.5 2"
          strokeLinecap="round"
          className="stroke-brand/50"
        />
      </g>
      <g transform="translate(8 52) rotate(-14)">
        <rect width="20.5" height="9" rx="2.25" className="lost-pick fill-brand" />
      </g>
    </svg>
  )
}

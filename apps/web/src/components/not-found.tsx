import { Link, useCanGoBack, useLocation, useRouter } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'

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
      <LostShuttle className="mb-8 w-72 max-w-full shrink-0 sm:w-80" />
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

function LostShuttle({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 24 250 112"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={cn('overflow-visible', className)}
    >
      <ellipse cx="92" cy="126" rx="52" ry="4" className="fill-foreground/5" />
      <path
        d="M14 80h14M4 94h18M14 108h10"
        strokeWidth="1.5"
        className="lost-trail stroke-muted-foreground/40"
      />
      <g transform="rotate(-6 90 92)">
        <g className="lost-shuttle">
          <path
            d="M28 92C52 72 128 72 152 92C128 112 52 112 28 92Z"
            strokeWidth="1.5"
            className="fill-card stroke-muted-foreground"
          />
          <path d="M28 92L42 84.5Q38 92 42 99.5Z" className="fill-muted-foreground/60" />
          <path d="M152 92L138 84.5Q142 92 138 99.5Z" className="fill-muted-foreground/60" />
          <path
            d="M50 83C72 78 108 78 130 83M50 101C72 106 108 106 130 101"
            strokeWidth="1"
            className="stroke-muted-foreground/30"
          />
          <rect
            x="70"
            y="85"
            width="40"
            height="14"
            rx="7"
            strokeWidth="1.25"
            className="fill-background stroke-muted-foreground"
          />
          <rect
            x="76"
            y="88.5"
            width="28"
            height="7"
            rx="3.5"
            strokeWidth="1"
            className="fill-brand/20 stroke-brand"
          />
          <path d="M83 89v6M90 89v6M97 89v6" strokeWidth="1" className="stroke-brand/60" />
        </g>
      </g>
      <path
        d="M152 85.5C170 82 176 92 186 80C194 70 186 52 196 42C206 30 230 32 234 48C238 62 222 66 216 74C212 79 212 84 212 90"
        pathLength={1}
        strokeWidth="2"
        className="lost-thread stroke-brand"
      />
      <circle cx="212" cy="104" r="3.5" className="lost-knot fill-brand" />
    </svg>
  )
}

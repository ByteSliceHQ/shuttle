import { Check, LoaderCircle, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'

import { desktop, type DesktopRunnerStatus } from './desktop'

/** A sandbox that is already set up starts in under a second; say nothing about that. */
const QUIET_MS = 800
/** How long "ready" stays after a setup the person watched. */
const READY_MS = 5000

const GETTING_READY = new Set(['starting', 'preparing', 'connecting'])

type Shown =
  | { kind: 'setup'; title: string; detail: string }
  | { kind: 'ready' }
  | { kind: 'problem'; title: string; detail: string }

/**
 * What the sandbox is doing, phrased for whoever is waiting on it. Null when there is nothing
 * worth saying: it is up, or nobody is signed in.
 */
export function describeSandbox(status: DesktopRunnerStatus | null): Shown | null {
  if (!status) {
    return null
  }

  if (GETTING_READY.has(status.status)) {
    // The runner only narrates the steps of a first setup. A plain start has no message.
    return status.status === 'preparing' && status.message
      ? {
          kind: 'setup',
          title: 'Setting up your sandbox',
          detail: `${status.message}. This happens once and takes about a minute.`,
        }
      : { kind: 'setup', title: 'Starting your sandbox', detail: '' }
  }

  if (status.status === 'error') {
    return {
      kind: 'problem',
      title: 'The local sandbox could not start',
      detail: status.message ?? 'Choose Sandbox, then Reconnect This Machine, to try again.',
    }
  }

  if (status.status === 'offline') {
    return {
      kind: 'problem',
      title: 'The local sandbox is not connected',
      detail: status.message ?? 'It reconnects on its own when Shuttle can be reached.',
    }
  }

  return null
}

interface Seen {
  readonly status: DesktopRunnerStatus | null
  /** When the sandbox began getting ready, while it still is. */
  readonly setupSince: number | null
  /** Until when to say it is ready, after a setup long enough to have been shown. */
  readonly readyUntil: number | null
}

/** What a new status from the runner changes. */
export function follow(before: Seen, status: DesktopRunnerStatus, at = Date.now()): Seen {
  if (GETTING_READY.has(status.status)) {
    return { status, setupSince: before.setupSince ?? at, readyUntil: null }
  }

  const watched = before.setupSince !== null && at - before.setupSince >= QUIET_MS

  return {
    status,
    setupSince: null,
    readyUntil: status.status === 'online' ? (watched ? at + READY_MS : before.readyUntil) : null,
  }
}

/**
 * The desktop app's sandbox, in the sidebar, while it is being set up or when it is in trouble.
 * Absent in a browser, and absent once the sandbox is simply running.
 */
export function LocalSandboxStatus() {
  const app = desktop()
  const [seen, setSeen] = useState<Seen>({ status: null, setupSince: null, readyUntil: null })
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!app) {
      return
    }

    const take = (status: DesktopRunnerStatus) => setSeen((before) => follow(before, status))

    void app.runnerStatus().then(take, () => {})

    return app.onRunnerStatus(take)
  }, [app])

  // The row appears and leaves on a clock, so the clock runs while there is something to time.
  const timing = seen.setupSince !== null || (seen.readyUntil !== null && now < seen.readyUntil)

  useEffect(() => {
    if (!timing) {
      return
    }

    const timer = setInterval(() => setNow(Date.now()), 250)

    return () => clearInterval(timer)
  }, [timing])

  const described = describeSandbox(seen.status)

  const shown: Shown | null =
    seen.readyUntil !== null && now < seen.readyUntil
      ? { kind: 'ready' }
      : described?.kind === 'setup' && now - (seen.setupSince ?? now) < QUIET_MS
        ? null
        : described

  if (!shown) {
    return null
  }

  return (
    <div className="shrink-0 border-t px-3 py-2.5" role="status" aria-live="polite">
      <div className="flex items-center gap-2 text-[12px] font-medium">
        {shown.kind === 'setup' ? (
          <LoaderCircle className="text-brand size-3.5 shrink-0 animate-spin" />
        ) : shown.kind === 'ready' ? (
          <Check className="text-brand size-3.5 shrink-0" />
        ) : (
          <TriangleAlert className="size-3.5 shrink-0 text-amber-500" />
        )}
        <span className="truncate">
          {shown.kind === 'ready' ? 'Your sandbox is ready' : shown.title}
        </span>
      </div>
      <p className="text-muted-foreground mt-1 pl-[22px] text-[11px] leading-snug wrap-anywhere">
        {shown.kind === 'ready'
          ? 'New sessions start on this machine.'
          : shown.kind === 'setup'
            ? `${shown.detail} New sessions start in the cloud until it is ready.`.trim()
            : shown.detail}
      </p>
    </div>
  )
}

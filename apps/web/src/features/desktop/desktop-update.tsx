import { ArrowDownToLine, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'

import { desktop, type DesktopUpdateStatus } from './desktop'

export function DesktopUpdate() {
  const app = desktop()
  const [status, setStatus] = useState<DesktopUpdateStatus | null>(null)

  useEffect(() => {
    if (!app?.updateStatus || !app.onUpdateStatus) {
      return
    }

    const stop = app.onUpdateStatus(setStatus)
    void app.updateStatus().then(setStatus, () => {})
    return stop
  }, [app])

  if (!status || status.status === 'disabled') {
    return null
  }

  if (status.status === 'manual') {
    return (
      <div className="shrink-0 border-t px-3 py-2">
        <a
          href="https://shuttle.codes/download/mac"
          target="_blank"
          rel="noreferrer"
          title={`Shuttle ${status.version} · Install updates manually until Apple signing is available`}
          className="text-muted-foreground hover:text-foreground flex items-center gap-2 rounded px-1 py-1.5 text-xs"
        >
          <ArrowDownToLine className="size-3.5 shrink-0" />
          Download latest Shuttle
        </a>
      </div>
    )
  }

  const pending = status.status === 'checking' || status.status === 'downloading'

  const label =
    status.status === 'ready'
      ? 'Restart to update Shuttle'
      : status.status === 'available'
        ? `Update to ${status.nextVersion}`
        : status.status === 'downloading'
          ? `Downloading update… ${status.progress ?? 0}%`
          : status.status === 'checking'
            ? 'Checking for updates…'
            : status.status === 'error'
              ? 'Update failed · Retry'
              : status.status === 'current'
                ? 'Shuttle is up to date · Check again'
                : 'Check for updates'

  function act() {
    const request =
      status?.status === 'ready'
        ? app?.installUpdate?.()
        : status?.status === 'available'
          ? app?.downloadUpdate?.()
          : app?.checkForUpdates?.()

    void request?.catch(() =>
      setStatus({
        status: 'error',
        version: status?.version ?? '',
        message: 'Could not update Shuttle. Try again.',
      }),
    )
  }

  return (
    <div className="shrink-0 border-t px-3 py-2">
      <button
        type="button"
        disabled={pending}
        onClick={act}
        title={status.message ?? `Shuttle ${status.version}`}
        className="text-muted-foreground hover:text-foreground flex w-full items-center gap-2 rounded px-1 py-1.5 text-left text-xs disabled:cursor-wait"
      >
        {status.status === 'available' ? (
          <ArrowDownToLine className="size-3.5 shrink-0" />
        ) : (
          <RefreshCw className={`size-3.5 shrink-0 ${pending ? 'animate-spin' : ''}`} />
        )}
        <span role="status" aria-live="polite">
          {label}
        </span>
      </button>
    </div>
  )
}

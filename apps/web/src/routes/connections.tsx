import { createFileRoute } from '@tanstack/react-router'
import { Check } from 'lucide-react'
import { useState } from 'react'

import { ConnectionsPanel } from '@/components/connections-panel'
import {
  setDefaultHarness,
  type Connection,
  type ConnectionsState,
  type HarnessId,
} from '@/lib/api'
import { cn, errorMessage } from '@/lib/cn'

export const Route = createFileRoute('/connections')({
  component: ConnectionsPage,
})

/** Where an agent is signed in, in a few words. */
function whereSignedIn(connection: Connection): string {
  if (connection.local === null) {
    return connection.cloud ? 'Your subscription' : 'Not connected'
  }

  if (connection.local && connection.cloud) {
    return 'Signed in on this machine and in the cloud'
  }

  return connection.local
    ? 'Signed in on this machine only'
    : connection.cloud
      ? 'Signed in in the cloud only'
      : 'Not connected'
}

function ConnectionsPage() {
  const [state, setState] = useState<ConnectionsState | null>(null)
  const [error, setError] = useState<string | null>(null)

  function choose(harness: HarnessId) {
    if (!state) {
      return
    }

    setState({ ...state, defaultHarness: harness })
    setError(null)

    setDefaultHarness(harness).catch((cause: unknown) => {
      setState(state)
      setError(errorMessage(cause))
    })
  }

  const options: { harness: HarnessId; label: string; detail: string; enabled: boolean }[] = [
    { harness: 'shuttle', label: 'Shuttle', detail: 'OpenRouter models', enabled: true },
    ...(state?.connections ?? []).map((connection) => ({
      harness: connection.harness as HarnessId,
      label: connection.label,
      detail: whereSignedIn(connection),
      enabled: connection.connected,
    })),
  ]

  return (
    <div className="h-full overflow-y-auto">
      <div className="stagger mx-auto flex w-full max-w-2xl flex-col gap-10 px-6 pt-16 pb-24">
        <section>
          <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
          <p className="text-muted-foreground mt-2 max-w-xl text-sm leading-relaxed text-pretty">
            Run sessions on your own coding agent subscription instead of OpenRouter. You sign in to
            the agent itself, inside the sandbox where your sessions run, and the sign-in stays
            there.
          </p>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium">Subscriptions</h2>
          <ConnectionsPanel onChanged={setState} />
        </section>

        <section className="flex flex-col gap-3">
          <div>
            <h2 className="text-sm font-medium">Default agent</h2>
            <p className="text-muted-foreground mt-1 text-xs">
              New sessions start on this agent. You can switch any session from its message box.
            </p>
          </div>
          <div role="radiogroup" aria-label="Default agent" className="flex flex-col gap-1.5">
            {options.map((option) => {
              const selected = state?.defaultHarness === option.harness

              return (
                <button
                  key={option.harness}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={!option.enabled || !state}
                  onClick={() => choose(option.harness)}
                  className={cn(
                    'bg-card ease-snappy flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors duration-150 outline-none',
                    'focus-visible:ring-ring/50 hover:bg-accent/50 focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50',
                    selected && 'border-foreground/30',
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="text-foreground block text-sm font-medium">
                      {option.label}
                    </span>
                    <span className="text-muted-foreground block text-xs">{option.detail}</span>
                  </span>
                  {selected ? <Check className="text-foreground size-4 shrink-0" /> : null}
                </button>
              )
            })}
          </div>
          {error ? <p className="text-status-failed text-xs wrap-anywhere">{error}</p> : null}
        </section>
      </div>
    </div>
  )
}

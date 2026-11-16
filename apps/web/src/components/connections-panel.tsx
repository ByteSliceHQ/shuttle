import { Cloud, Laptop, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'

import {
  disconnectHarness,
  fetchConnections,
  signedInAt,
  type Connection,
  type ConnectionsState,
  type SignInPlace,
} from '@/lib/api'
import { cn, errorMessage } from '@/lib/cn'

import { SignInProgress, useSignIn } from './sign-in'
import { Button } from './ui/button'

/**
 * Connect, check and remove coding agent subscriptions. Each agent shows every place it can be
 * signed in at once: in the desktop app that is this machine and the cloud, which keep separate
 * sign-ins because a session uses the one where it runs.
 */
export function ConnectionsPanel({ onChanged }: { onChanged?: (state: ConnectionsState) => void }) {
  const [state, setState] = useState<ConnectionsState | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(
    () =>
      fetchConnections().then(
        (next) => {
          setState(next)
          setError(null)
          onChanged?.(next)
        },
        (cause: unknown) => setError(errorMessage(cause)),
      ),
    [onChanged],
  )

  useEffect(() => {
    void reload()
  }, [reload])

  const places: readonly SignInPlace[] = state?.machine ? ['local', 'cloud'] : ['cloud']

  return (
    <div className="flex flex-col gap-3">
      {state?.machine ? (
        <p className="text-muted-foreground text-xs text-pretty">
          A session uses the sign-in where it runs, so sign in at each place you work. A sign-in on
          this machine stays in its sandbox here.
        </p>
      ) : null}

      {error ? <p className="text-status-failed text-xs wrap-anywhere">{error}</p> : null}

      {state && state.mode !== 'container' ? (
        <Notice>
          Subscriptions need the container sandbox. Set{' '}
          <code className="text-foreground">SHUTTLE_WORKSPACE_MODE=container</code> in{' '}
          <code className="text-foreground">apps/worker/.dev.vars</code> and restart.
        </Notice>
      ) : null}

      {state && !state.canStore ? (
        <Notice>
          <code className="text-foreground">SHUTTLE_CREDENTIALS_KEY</code> is not set, so sign-ins
          cannot be stored. Restart with <code className="text-foreground">bun run dev</code> to
          generate one.
        </Notice>
      ) : null}

      {state?.connections.map((connection) => (
        <div key={connection.harness} className="bg-card rounded-xl border">
          <p className="text-foreground px-4 pt-3.5 pb-1 text-sm font-medium">{connection.label}</p>
          <div className="divide-y">
            {places.map((place) => (
              <PlaceRow
                key={place}
                connection={connection}
                place={place}
                showPlace={places.length > 1}
                disabled={state.mode !== 'container' || !state.canStore}
                onChanged={reload}
              />
            ))}
          </div>
        </div>
      ))}

      {!state && !error ? (
        <p className="text-muted-foreground flex items-center gap-2 text-xs">
          <Loader2 className="size-3.5 animate-spin" /> Loading
        </p>
      ) : null}
    </div>
  )
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="text-muted-foreground bg-muted/40 rounded-lg border px-3 py-2 text-xs leading-relaxed">
      {children}
    </p>
  )
}

/** One agent at one place: whether it is signed in there, and the way to change that. */
function PlaceRow({
  connection,
  place,
  showPlace,
  disabled,
  onChanged,
}: {
  connection: Connection
  place: SignInPlace
  showPlace: boolean
  disabled: boolean
  onChanged: () => Promise<void>
}) {
  const flow = useSignIn(connection.harness, place, onChanged)
  const signedIn = signedInAt(connection, place) === true
  const updatedAt = place === 'cloud' ? connection.updatedAt : null

  async function disconnect() {
    await disconnectHarness(connection.harness, place).catch(() => {})
    await onChanged()
  }

  return (
    <div className="px-4 py-2.5">
      <div className="flex min-h-8 items-center gap-3">
        {showPlace ? (
          place === 'local' ? (
            <Laptop className="text-muted-foreground size-3.5 shrink-0" />
          ) : (
            <Cloud className="text-muted-foreground size-3.5 shrink-0" />
          )
        ) : null}
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          {showPlace ? (
            <span className="text-foreground w-24 shrink-0 text-xs">
              {place === 'local' ? 'This machine' : 'Cloud'}
            </span>
          ) : null}
          <span
            className={cn(
              'inline-flex min-w-0 items-center gap-1.5 truncate text-xs',
              signedIn ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'size-1.5 shrink-0 rounded-full',
                signedIn ? 'bg-emerald-500' : 'bg-muted-foreground/40',
              )}
            />
            {signedIn
              ? `Signed in${updatedAt ? ` · ${new Date(updatedAt).toLocaleDateString()}` : ''}`
              : 'Not signed in'}
          </span>
        </div>
        {flow.busy ? (
          <Button size="sm" variant="ghost" onClick={() => void flow.cancel()}>
            Cancel
          </Button>
        ) : signedIn ? (
          <>
            <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void flow.start()}>
              Sign in again
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void disconnect()}>
              Disconnect
            </Button>
          </>
        ) : (
          <Button size="sm" disabled={disabled} onClick={() => void flow.start()}>
            {flow.signIn?.step === 'failed' ? 'Try again' : 'Sign in'}
          </Button>
        )}
      </div>

      {flow.signIn ? (
        <div className="mt-2">
          <SignInProgress
            label={connection.label}
            place={place}
            signIn={flow.signIn}
            onSubmitCode={(code) => void flow.submitCode(code)}
          />
        </div>
      ) : null}
    </div>
  )
}

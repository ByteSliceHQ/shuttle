import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Cloud, Laptop } from 'lucide-react'
import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import { useApi, useShuttleHost } from '@/shuttle'
import type { Connection } from '@shuttle/api'

import { SignInProgress, useSignIn } from './agent-sign-in'
import { placeContext, signedInAt, type SignInPlace } from './places'
import { connectionsQuery } from './queries'

/**
 * Connect, check and remove coding agent subscriptions. Each agent shows every place it can be
 * signed in at once: in the desktop app that is this machine and the cloud, which keep separate
 * sign-ins because a session uses the one where it runs.
 *
 * The page's loader has the connections ready before this renders.
 */
export function ConnectionsPanel() {
  const host = useShuttleHost()
  const { data: state, error } = useSuspenseQuery(connectionsQuery(host))

  const places: readonly SignInPlace[] = state.machine ? ['local', 'cloud'] : ['cloud']

  return (
    <div className="flex flex-col gap-3">
      {state.machine ? (
        <p className="text-muted-foreground text-xs text-pretty">
          A session uses the sign-in where it runs, so sign in at each place you work. A sign-in on
          this machine stays in its sandbox here.
        </p>
      ) : null}

      {/* Reading again failed. What was read before is still shown below. */}
      {error ? <p className="text-status-failed text-xs wrap-anywhere">{error.message}</p> : null}

      {state.mode !== 'container' ? (
        <Notice>
          Subscriptions need the container sandbox. Set{' '}
          <code className="text-foreground">SHUTTLE_WORKSPACE_MODE=container</code> in{' '}
          <code className="text-foreground">apps/worker/.dev.vars</code> and restart.
        </Notice>
      ) : null}

      {!state.canStore ? (
        <Notice>
          <code className="text-foreground">SHUTTLE_CREDENTIALS_KEY</code> is not set, so sign-ins
          cannot be stored. Restart with <code className="text-foreground">bun run dev</code> to
          generate one.
        </Notice>
      ) : null}

      {state.connections.map((connection) => (
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
              />
            ))}
          </div>
        </div>
      ))}
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
}: {
  connection: Connection
  place: SignInPlace
  showPlace: boolean
  disabled: boolean
}) {
  const host = useShuttleHost()
  const api = useApi()
  const queryClient = useQueryClient()
  const flow = useSignIn(connection.harness, place)
  const signedIn = signedInAt(connection, place) === true
  const updatedAt = place === 'cloud' ? connection.updatedAt : null

  const disconnect = useMutation(
    api.connections.disconnect.mutationOptions({
      context: placeContext(host, place),
      // Whether or not it worked, show where the agent is signed in now.
      onSettled: () => queryClient.invalidateQueries({ queryKey: api.connections.key() }),
    }),
  )

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
          <Button size="sm" variant="ghost" onClick={flow.cancel}>
            Cancel
          </Button>
        ) : signedIn ? (
          <>
            <Button size="sm" variant="ghost" disabled={disabled} onClick={flow.start}>
              Sign in again
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate({ harness: connection.harness })}
            >
              Disconnect
            </Button>
          </>
        ) : (
          <Button size="sm" disabled={disabled} onClick={flow.start}>
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
            onSubmitCode={flow.submitCode}
          />
        </div>
      ) : null}

      {disconnect.error ? (
        <p className="text-status-failed mt-2 text-xs wrap-anywhere">{disconnect.error.message}</p>
      ) : null}
    </div>
  )
}

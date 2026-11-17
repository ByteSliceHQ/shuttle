import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Check } from 'lucide-react'

import { api } from '@/api/client'
import { ConnectionsPanel } from '@/features/connections/connections-panel'
import { connectionsQuery } from '@/features/connections/queries'
import { cn } from '@/lib/cn'
import type { Connection, HarnessId } from '@shuttle/api'

export const Route = createFileRoute('/_app/connections')({
  loader: ({ context }) =>
    context.queryClient.query({ ...connectionsQuery(), staleTime: 'static' }),
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

interface AgentOption {
  readonly harness: HarnessId
  readonly label: string
  readonly detail: string
  readonly enabled: boolean
}

function ConnectionsPage() {
  const queryClient = useQueryClient()
  const { data: state } = useSuspenseQuery(connectionsQuery())
  const listKey = connectionsQuery().queryKey

  const setDefault = useMutation(
    api.connections.setDefault.mutationOptions({
      // Shown as chosen at once, and put back if the Worker refuses.
      onMutate: async ({ harness }) => {
        // A read already on its way would put the old choice back when it lands.
        await queryClient.cancelQueries({ queryKey: listKey })

        const before = queryClient.getQueryData(listKey)

        if (before && harness) {
          queryClient.setQueryData(listKey, { ...before, defaultHarness: harness })
        }

        return { before }
      },
      onError: (_cause, _input, changed) => {
        if (changed?.before) {
          queryClient.setQueryData(listKey, changed.before)
        }
      },
      onSettled: () => queryClient.invalidateQueries({ queryKey: api.connections.key() }),
    }),
  )

  const options: AgentOption[] = [
    { harness: 'shuttle', label: 'Shuttle', detail: 'OpenRouter models', enabled: true },
    ...state.connections.map((connection) => ({
      harness: connection.harness,
      label: connection.label,
      detail: whereSignedIn(connection),
      enabled: connection.connected,
    })),
  ]

  // An agent the deployment adds over ACP has no sign-in to list above. When it is the default
  // it is still shown as the choice in force, by the only name known for it here.
  if (!options.some((option) => option.harness === state.defaultHarness)) {
    options.push({
      harness: state.defaultHarness,
      label: state.defaultHarness.replace(/^acp:/, ''),
      detail: 'Added by this deployment',
      enabled: true,
    })
  }

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
          <ConnectionsPanel />
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
              const selected = state.defaultHarness === option.harness

              return (
                <button
                  key={option.harness}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={!option.enabled}
                  onClick={() => setDefault.mutate({ harness: option.harness })}
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
          {setDefault.error ? (
            <p className="text-status-failed text-xs wrap-anywhere">{setDefault.error.message}</p>
          ) : null}
        </section>
      </div>
    </div>
  )
}

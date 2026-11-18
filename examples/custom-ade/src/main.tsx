import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { StrictMode, Suspense, useMemo, type AnchorHTMLAttributes } from 'react'
import { createRoot } from 'react-dom/client'

import {
  createShuttleHost,
  defaultArtifactTypes,
  Shuttle,
  useSession,
  type ArtifactType,
  type ShuttleDestination,
  type ShuttleIdentity,
  type ShuttleRouter,
} from '@shuttle/react'
import { TooltipProvider } from '@shuttle/react/ui'

import './styles.css'

const host = createShuttleHost()
const queryClient = new QueryClient()
const sessionId = new URLSearchParams(location.search).get('session') ?? ''

// This host has one page, so every destination is that page.
const router: ShuttleRouter = {
  Link: ({ to, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: ShuttleDestination }) => (
    <a {...rest} href={to.page === 'session' ? `?session=${to.sessionId}` : '#'} />
  ),
  navigate: () => {},
  location: { page: 'session', sessionId },
}

const notes: ArtifactType = {
  kind: 'acme:notes',
  label: 'Notes',
  icon: null,
  single: true,
  launcher: {},
  render: ({ runId }) => (
    <p data-notes className="p-4 text-[13px]">
      Notes for {runId.slice(-6)}
    </p>
  ),
}

/** A part of this host's own, reading the same session the stock parts do. */
function StatusStrip() {
  const { status, identities, events } = useSession()

  return (
    <div data-status-strip className="text-muted-foreground border-b px-3 py-1 text-[11px]">
      custom strip · {status} · {identities.size} agents · {events.length} events
    </div>
  )
}

function MyCustomADE() {
  const tenant = useQuery({ queryKey: ['me'], queryFn: () => host.client.tenant.me() }).data

  const identity = useMemo<ShuttleIdentity | null>(
    () => (tenant ? { tenant, listPeople: async () => [] } : null),
    [tenant],
  )

  if (!identity) {
    return <p className="p-4">Signing in…</p>
  }

  return (
    <Shuttle.Provider host={host} router={router} identity={identity}>
      <Suspense fallback={<p className="p-4">Opening…</p>}>
        <Shuttle.Session id={sessionId} artifactTypes={[...defaultArtifactTypes, notes]}>
          <div className="grid h-dvh grid-cols-[minmax(0,1fr)_420px] grid-rows-[auto_auto_minmax(0,1fr)]">
            <div className="col-span-2">
              <Shuttle.SessionHeader />
            </div>
            <div className="col-span-2">
              <StatusStrip />
            </div>
            <main className="flex min-h-0 flex-col">
              <Shuttle.Conversation />
              <Shuttle.Composer />
            </main>
            <aside className="min-h-0 border-l">
              <Shuttle.Artifacts />
            </aside>
          </div>
          <Shuttle.Palette />
        </Shuttle.Session>
      </Suspense>
    </Shuttle.Provider>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <MyCustomADE />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
)

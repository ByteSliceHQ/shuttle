import { noop } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useCallback } from 'react'
import { z } from 'zod'

import { host } from '@/host'
import { whenRunSynced } from '@/lib/run-stores'
import { connectionsQuery, sessionQueries, Shuttle } from '@shuttle/react'

const SessionSearch = z.object({
  /** Agent thread to inspect on open, e.g. the one that opened a linked PR. */
  thread: z.string().min(1).optional().catch(undefined),
  /** Agent thread whose own timeline is open in the conversation. */
  view: z.string().min(1).optional().catch(undefined),
})

export const Route = createFileRoute('/_app/sessions/$sessionId')({
  validateSearch: SessionSearch,
  // The conversation and the status are folded from the session's event log, so the page waits
  // for it and arrives whole instead of saying "Connecting" and filling in as events land.
  //
  // This is in `beforeLoad` because that runs, and is waited for, on every way into the page.
  // A loader's result is kept from when the link was pointed at, and the router shows the page
  // from it at once. Pointing at a link is not reason enough to open a socket to every session
  // the pointer passes, so the logs are opened only when the page is really being entered.
  beforeLoad: async ({ context: { tenant }, params: { sessionId }, preload }) => {
    if (!preload) {
      await whenRunSynced(sessionId, tenant.user.id)
    }
  },
  // Everything the page shows from the Worker is read before it does, so nothing in it appears
  // late. Pointing at a session's link runs this too, so it is usually all there by the click.
  loader: async ({ context: { queryClient }, params: { sessionId } }) => {
    const session = sessionQueries(host, sessionId)

    await Promise.all([
      // The page cannot be drawn without these: a failure is the page's failure.
      queryClient.query({ ...session.harness, staleTime: 'static' }),
      queryClient.query({ ...session.team, staleTime: 'static' }),
      queryClient.query({ ...session.vendorModels, staleTime: 'static' }),
      // The title bar's avatars, where the session runs, and who is signed in where. The page
      // waits for them so they do not pop in, and still opens if one cannot be read.
      queryClient.query({ ...session.access, staleTime: 'static' }).catch(noop),
      queryClient.query({ ...session.place, staleTime: 'static' }).catch(noop),
      queryClient.query({ ...connectionsQuery(host), staleTime: 'static' }).catch(noop),
    ])
  },
  component: SessionPage,
})

function SessionPage() {
  const { sessionId } = Route.useParams()
  const { thread, view } = Route.useSearch()
  const navigate = Route.useNavigate()

  // The open thread lives in the URL, so a timeline can be linked to and Back leaves it.
  const openThread = useCallback(
    (threadId: string | undefined) => {
      void navigate({ search: (previous) => ({ ...previous, view: threadId }) })
    },
    [navigate],
  )

  return (
    <Shuttle.Session id={sessionId} thread={view} onThreadChange={openThread} focusThread={thread}>
      <Shuttle.SessionLayout />
    </Shuttle.Session>
  )
}

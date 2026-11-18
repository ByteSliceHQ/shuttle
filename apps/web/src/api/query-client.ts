import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'

import { isSignedOut, statusOf } from './client'

/** Called when any request finds the browser is no longer signed in. */
let onSignedOut: (() => void) | undefined

export function whenSignedOut(handler: () => void): void {
  onSignedOut = handler
}

function noticeSignOut(cause: unknown): void {
  if (isSignedOut(cause)) {
    onSignedOut?.()
  }
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: noticeSignOut }),
  mutationCache: new MutationCache({ onError: noticeSignOut }),
  defaultOptions: {
    queries: {
      // What a loader read is still good when the page it was read for renders, and for moving
      // between pages shortly after. Anything older is shown at once and read again behind it.
      staleTime: 30_000,
      gcTime: 10 * 60_000,
      // A request the Worker refused will be refused again. Only failures to reach it, and its
      // own errors, are worth another try.
      retry: (failures, cause) => {
        const status = statusOf(cause)

        return failures < 2 && (status === undefined || status >= 500)
      },
    },
  },
})

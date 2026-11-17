import type { QueryClient } from '@tanstack/react-query'
import { createRouter } from '@tanstack/react-router'

import { queryClient } from '@/api/query-client'
import { RouteError } from '@/components/route-error'
import { RoutePending } from '@/components/route-pending'
import { desktop } from '@/features/desktop/desktop'
import { reportTiming } from '@/lib/timing'

import { routeTree } from './routeTree.gen'

/** What every route's `beforeLoad` and `loader` are given. */
export interface RouterContext {
  readonly queryClient: QueryClient
}

const router = createRouter({
  routeTree,
  context: { queryClient } satisfies RouterContext,
  // Pointing at a link runs the page's loaders, so its data is usually there before the click.
  defaultPreload: 'intent',
  // The query cache decides what is fresh. The router asks every time and never keeps its own copy.
  defaultPreloadStaleTime: 0,
  // A page change waits for its loaders with the page being left still on screen (see
  // `NavigationProgress`). Only a wait this long swaps in the pending page.
  defaultPendingMs: 1000,
  defaultPendingMinMs: 300,
  defaultPendingComponent: RoutePending,
  defaultErrorComponent: RouteError,
  scrollRestoration: true,
})

// The desktop app sends the page places: a menu item, a notification, a `shuttle://` link.
desktop()?.onNavigate?.((path) => {
  router.history.push(path)
})

// How long a page change takes, from the click to the new page being ready to show.
let navigatedAt: number | undefined

router.subscribe('onBeforeNavigate', () => {
  navigatedAt = performance.now()
})

router.subscribe('onResolved', (event) => {
  if (navigatedAt === undefined || !event.pathChanged) {
    return
  }

  reportTiming({
    type: 'route.resolved',
    durationMs: performance.now() - navigatedAt,
    // The route, not the address, so sessions and folders group together.
    route: router.state.matches.at(-1)?.routeId,
  })

  navigatedAt = undefined
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

export function getRouter() {
  return router
}

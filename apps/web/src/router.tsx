import { createRouter } from '@tanstack/react-router'

import { desktop } from './lib/desktop'
import { reportTiming } from './lib/timing'
import { routeTree } from './routeTree.gen'

const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
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

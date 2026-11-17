import { createRootRouteWithContext, Outlet } from '@tanstack/react-router'

import { NavigationProgress } from '@/components/navigation-progress'
import { RouteNotFound } from '@/components/not-found'
import type { RouterContext } from '@/router'
import { TooltipProvider } from '@shuttle/react/ui'

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  notFoundComponent: RouteNotFound,
})

function RootLayout() {
  return (
    <TooltipProvider>
      <NavigationProgress />
      <Outlet />
    </TooltipProvider>
  )
}

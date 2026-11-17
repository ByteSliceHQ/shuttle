import { createRootRouteWithContext, Outlet } from '@tanstack/react-router'

import { NavigationProgress } from '@/components/navigation-progress'
import { RouteNotFound } from '@/components/not-found'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { RouterContext } from '@/router'

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

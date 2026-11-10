import { createRootRoute, Outlet } from '@tanstack/react-router'

import { RouteNotFound } from '@/components/not-found'
import { AppSidebarShell } from '@/components/sidebar/app-sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: RouteNotFound,
})

function RootLayout() {
  return (
    <TooltipProvider>
      <AppSidebarShell>
        <Outlet />
      </AppSidebarShell>
    </TooltipProvider>
  )
}

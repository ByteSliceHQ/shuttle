import { createRootRoute, Outlet } from '@tanstack/react-router'

import { GithubConnectBanner } from '@/components/github-connect-banner'
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
        <div className="flex h-full min-h-0 flex-col">
          <GithubConnectBanner />
          <div className="min-h-0 flex-1">
            <Outlet />
          </div>
        </div>
      </AppSidebarShell>
    </TooltipProvider>
  )
}

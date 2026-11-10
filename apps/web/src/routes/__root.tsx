import { createRootRoute, Link, Outlet, useRouterState } from '@tanstack/react-router'
import { BookOpen, Orbit, SquareStack } from 'lucide-react'
import type { ReactNode } from 'react'

import { TooltipProvider } from '@/components/ui/tooltip'
import { cn } from '@/lib/cn'

export const Route = createRootRoute({
  component: RootLayout,
})

function RootLayout() {
  const inSession = useRouterState({
    select: (state) => state.location.pathname.startsWith('/sessions/'),
  })

  return (
    <TooltipProvider>
      <div className="flex h-dvh min-h-0 flex-col">
        {inSession ? null : <AppHeader />}
        <div className="min-h-0 flex-1">
          <Outlet />
        </div>
      </div>
    </TooltipProvider>
  )
}

function AppHeader() {
  return (
    <header className="flex h-12 shrink-0 items-center gap-6 border-b px-4">
      <Link to="/" className="flex items-center gap-2">
        <span className="bg-brand/15 text-brand ring-brand/25 flex size-6 items-center justify-center rounded-md ring-1 ring-inset">
          <Orbit className="size-3.5" />
        </span>
        <span className="text-[13px] font-semibold tracking-tight">Shuttle</span>
      </Link>
      <nav className="flex items-center gap-1 text-[13px]">
        <NavLink to="/" icon={<SquareStack className="size-3.5" />}>
          Sessions
        </NavLink>
        <NavLink to="/playbook" icon={<BookOpen className="size-3.5" />}>
          Playbook
        </NavLink>
      </nav>
      <span className="text-muted-foreground ml-auto hidden text-xs sm:inline">
        Powered by Looms on Cloudflare
      </span>
    </header>
  )
}

function NavLink({
  to,
  icon,
  children,
}: {
  to: '/' | '/playbook'
  icon: ReactNode
  children: ReactNode
}) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: true }}
      className={cn(
        'text-muted-foreground hover:text-foreground flex h-7 items-center gap-1.5 rounded-md px-2.5 transition-colors duration-150',
        'data-[status=active]:bg-accent data-[status=active]:text-foreground',
      )}
    >
      {icon}
      {children}
    </Link>
  )
}

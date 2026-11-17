import { noop } from '@tanstack/react-query'
import { useSuspenseQuery } from '@tanstack/react-query'
import {
  createFileRoute,
  Outlet,
  redirect,
  useNavigate,
  type ErrorComponentProps,
} from '@tanstack/react-router'
import { useEffect, useMemo } from 'react'
import { z } from 'zod'

import { api } from '@/api/client'
import { RouteError } from '@/components/route-error'
import { Button } from '@/components/ui/button'
import { authClient } from '@/features/auth/auth-client'
import { acceptInvitation, InvitationError } from '@/features/auth/invitation'
import { listOrgMembers, orgMembersQuery } from '@/features/auth/org-people'
import { tenantQuery } from '@/features/auth/tenant'
import { connectionsQuery } from '@/features/connections/queries'
import { GithubConnectBanner } from '@/features/github/github-connect-banner'
import { AppSidebarShell } from '@/features/workspace/app-sidebar'
import { host } from '@/host'
import { whenRunSynced } from '@/lib/run-stores'
import { Shuttle } from '@/parts'
import type { ShuttleIdentity } from '@/shuttle'
import { useShuttleRouter } from '@/shuttle-router'

const AppSearch = z.object({
  /** An invitation link: `/?invite=<id>`. Accepted on the way in. */
  invite: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .optional()
    .catch(undefined),
  /** How connecting GitHub went, when the page was opened by GitHub sending the person back. */
  github: z
    .enum([
      'connected',
      'requested',
      'already_connected',
      'missing_installation',
      'invalid_state',
      'not_found',
      'error',
    ])
    .optional()
    .catch(undefined),
})

/**
 * Everything behind the sign-in. Its `beforeLoad` settles who is signed in before any page
 * under it loads, so every loader and component below can rely on a tenant.
 */
export const Route = createFileRoute('/_app')({
  validateSearch: AppSearch,
  beforeLoad: async ({ context: { queryClient }, search: { invite }, preload }) => {
    // The app opens as whoever was last signed in here, and the Worker's answer corrects it.
    // An invitation changes who that is, so it always waits for the Worker.
    const tenant = invite
      ? await queryClient.query({ ...tenantQuery, staleTime: 0 })
      : await queryClient.query({ ...tenantQuery, staleTime: 'static' })

    if (!tenant) {
      throw redirect({ to: '/sign-in', search: { invite } })
    }

    if (invite) {
      await acceptInvitation(invite)

      // Everything on the page belongs to the previous organization, so start again in the new
      // one. Nothing after this renders: the page is on its way out.
      window.location.replace('/')
      await new Promise<never>(() => {})
    }

    // Pull requests are folded from the organization's pulls run, and the sidebar and most
    // pages show them. Waiting here means they are there when a page shows, not a moment after.
    // Once the log is in this costs nothing, so it is asked on every page change.
    if (!preload) {
      await whenRunSynced(tenant.runs.pulls, tenant.user.id)
    }

    return { tenant }
  },
  // What every page shows is read once here: the sidebar's workspace, who is signed in to
  // which agent (the message box on most pages asks), and people's names. Pages add their own.
  loader: async ({ context: { queryClient, tenant } }) => {
    await Promise.all([
      queryClient.query({ ...api.workspace.get.queryOptions(), staleTime: 'static' }),
      // The app still opens if this cannot be read; what needs it says so in place.
      queryClient.query({ ...connectionsQuery(host), staleTime: 'static' }).catch(noop),
      // People's names, for the avatars and bylines on most pages.
      queryClient.query({ ...orgMembersQuery(tenant.org.id), staleTime: 'static' }).catch(noop),
    ])
  },
  errorComponent: AppError,
  component: AppLayout,
})

function AppLayout() {
  const { data: tenant } = useSuspenseQuery(tenantQuery)
  const navigate = useNavigate()
  const router = useShuttleRouter()

  // The Worker can answer, behind an app already on screen, that the sign-in has ended.
  useEffect(() => {
    if (!tenant) {
      void navigate({ to: '/sign-in' })
    }
  }, [tenant, navigate])

  // Who is signed in, as Shuttle's components are told it. Sign-in is this app's own business.
  const identity = useMemo<ShuttleIdentity | null>(
    () => (tenant ? { tenant, listPeople: listOrgMembers, connectGithub } : null),
    [tenant],
  )

  if (!identity) {
    return null
  }

  return (
    <Shuttle.Provider host={host} router={router} identity={identity}>
      <AppSidebarShell>
        <div className="flex h-full min-h-0 flex-col">
          <GithubConnectBanner />
          <div className="min-h-0 flex-1">
            <Outlet />
          </div>
        </div>
      </AppSidebarShell>
    </Shuttle.Provider>
  )
}

/** Links the person's GitHub account to their sign-in, and brings them back to this page. */
function connectGithub(): void {
  void authClient.linkSocial({
    provider: 'github',
    callbackURL: window.location.href,
    // A refusal comes back here too, not to a page outside the app.
    errorCallbackURL: window.location.href,
  })
}

function AppError(props: ErrorComponentProps) {
  if (props.error instanceof InvitationError) {
    return (
      <Notice title="The invitation was not accepted" detail={props.error.message}>
        <Button variant="outline" onClick={() => window.location.replace('/')}>
          Continue to Shuttle
        </Button>
      </Notice>
    )
  }

  return (
    <div className="h-dvh">
      <RouteError {...props} />
    </div>
  )
}

function Notice({
  title,
  detail,
  children,
}: {
  title: string
  detail?: string
  children?: React.ReactNode
}) {
  return (
    <div className="flex min-h-dvh items-center justify-center px-6">
      <div className="flex max-w-sm flex-col items-start gap-3">
        <h1 className="text-[15px] font-semibold tracking-tight">{title}</h1>
        {detail ? (
          <p className="text-muted-foreground text-[13px] leading-relaxed text-pretty">{detail}</p>
        ) : null}
        {children}
      </div>
    </div>
  )
}

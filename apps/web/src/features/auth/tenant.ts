import { queryOptions, type QueryClient } from '@tanstack/react-query'
import { createContext, useContext } from 'react'

import { client, isSignedOut } from '@/api/client'
import { Tenant } from '@shuttle/api'

export type { OrgRole, Tenant } from '@shuttle/api'

const REMEMBERED_KEY = 'shuttle.tenant'

/**
 * Who this browser was last signed in as, so the app can open at once and check with the Worker
 * behind it. It names a person and their runs and grants nothing: every request still carries
 * the sign-in cookie, and the Worker's answer replaces this as soon as it arrives.
 */
function rememberedTenant(): Tenant | null {
  try {
    const parsed = Tenant.safeParse(JSON.parse(localStorage.getItem(REMEMBERED_KEY) ?? 'null'))

    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Keeps `tenant` for the next launch, or forgets the last one when given null. */
export function rememberTenant(tenant: Tenant | null): void {
  try {
    if (tenant) {
      localStorage.setItem(REMEMBERED_KEY, JSON.stringify(tenant))
    } else {
      localStorage.removeItem(REMEMBERED_KEY)
    }
  } catch {
    // No storage. The app simply asks the Worker first, as it always did.
  }
}

/**
 * Who the Worker says this browser is signed in as, or null when it is signed out. Any other
 * failure is an error: the Worker could not be asked.
 */
export const tenantQuery = queryOptions({
  queryKey: ['tenant'] as const,
  queryFn: async ({ signal }): Promise<Tenant | null> => {
    try {
      const tenant = await client.tenant.me(undefined, { signal })

      rememberTenant(tenant)

      return tenant
    } catch (cause) {
      if (!isSignedOut(cause)) {
        throw cause
      }

      rememberTenant(null)

      return null
    }
  },
  // Compared by value, so the Worker confirming who was remembered re-renders nothing.
  structuralSharing: true,
})

/**
 * Starts the app as whoever was last signed in here. The entry is already stale, so the first
 * page shows at once and the Worker is asked behind it.
 */
export function seedRememberedTenant(queryClient: QueryClient): void {
  const remembered = rememberedTenant()

  if (remembered) {
    queryClient.setQueryData(tenantQuery.queryKey, remembered, { updatedAt: 0 })
  }
}

export const TenantContext = createContext<Tenant | null>(null)

/** The signed-in person and their organization. Available to everything under the app layout. */
export function useTenant(): Tenant {
  const tenant = useContext(TenantContext)

  if (!tenant) {
    throw new Error('useTenant must be used inside the signed-in app layout')
  }

  return tenant
}

export function invitationLink(origin: string, invitationId: string): string {
  return `${origin}/?invite=${encodeURIComponent(invitationId)}`
}

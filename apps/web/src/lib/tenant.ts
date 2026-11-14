import { createContext, useContext } from 'react'

export type OrgRole = 'owner' | 'admin' | 'member'

/** The signed-in person, the organization they are working in, and that organization's runs. */
export interface Tenant {
  readonly user: { readonly id: string; readonly name: string; readonly email: string }
  readonly org: { readonly id: string; readonly role: OrgRole }
  readonly runs: {
    readonly workspace: string
    readonly pulls: string
    readonly playbook: string
  }
}

export interface SignInProviders {
  readonly emailAndPassword: boolean
  readonly github: boolean
}

export type TenantResult =
  | { readonly kind: 'signed-in'; readonly tenant: Tenant }
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'unavailable'; readonly message: string }

/** Who the Worker says this browser is signed in as. */
export async function fetchTenant(): Promise<TenantResult> {
  const response = await fetch('/me')

  if (response.status === 401) {
    return { kind: 'signed-out' }
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null

    return {
      kind: 'unavailable',
      message: body?.error ?? `Shuttle could not check your sign-in (${response.status}).`,
    }
  }

  return { kind: 'signed-in', tenant: (await response.json()) as Tenant }
}

export async function fetchSignInProviders(): Promise<SignInProviders> {
  const response = await fetch('/auth/providers')

  if (!response.ok) {
    return { emailAndPassword: true, github: false }
  }

  return (await response.json()) as SignInProviders
}

export const TenantContext = createContext<Tenant | null>(null)

export function useTenant(): Tenant {
  const tenant = useContext(TenantContext)

  if (!tenant) {
    throw new Error('useTenant must be used inside AuthGate')
  }

  return tenant
}

/** The invitation an `?invite=<id>` link carries, if the page was opened from one. */
export function pendingInvitationId(search: string): string | null {
  const id = new URLSearchParams(search).get('invite')?.trim()

  return id && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null
}

export function invitationLink(origin: string, invitationId: string): string {
  return `${origin}/?invite=${encodeURIComponent(invitationId)}`
}

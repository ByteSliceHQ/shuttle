import { oc } from '@orpc/contract'
import { z } from 'zod'

import { DEFAULT_RUN_NAMES, tenantRunIds, type RunNames } from './run-id'

export const OrgRole = z.enum(['owner', 'admin', 'member'])
export type OrgRole = z.infer<typeof OrgRole>

/** The signed-in person, the organization they are working in, and that organization's runs. */
export const Tenant = z.object({
  user: z.object({ id: z.string(), name: z.string(), email: z.string() }),
  org: z.object({ id: z.string(), role: OrgRole }),
  runs: z.object({
    workspace: z.string(),
    /** The person's own workspace run, which no one else in the organization opens. */
    personal: z.string(),
    /** Null for a host that keeps no pull request inbox. */
    pulls: z.string().nullable(),
    playbook: z.string(),
  }),
})
export type Tenant = z.infer<typeof Tenant>

export interface SessionTenantInput {
  readonly user: Tenant['user']
  readonly orgId: string
  /** Defaults to `member`, which shows no organization settings. */
  readonly role?: OrgRole
  /** The deployment's names for the organization's runs, when it renames them. */
  readonly runNames?: Partial<Pick<RunNames, 'workspace' | 'playbook'>>
}

/**
 * The tenant for a host that serves sessions only, with no `GET /me` and no pull request inbox,
 * so a page gives `<Shuttle.Provider>` its identity from what it already knows about the person:
 *
 * ```ts
 * const tenant = sessionTenant({ user: { id, name, email }, orgId })
 * ```
 */
export function sessionTenant({ user, orgId, role, runNames }: SessionTenantInput): Tenant {
  const runs = tenantRunIds(orgId, user.id, { ...DEFAULT_RUN_NAMES, ...runNames })

  return {
    user,
    org: { id: orgId, role: role ?? 'member' },
    runs: { ...runs, pulls: null },
  }
}

export const tenantContract = {
  /** Who the Worker says this request is signed in as. */
  me: oc.route({ method: 'GET', path: '/me' }).output(Tenant),
}

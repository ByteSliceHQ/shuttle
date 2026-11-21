import { oc } from '@orpc/contract'
import { z } from 'zod'

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

export const tenantContract = {
  /** Who the Worker says this request is signed in as. */
  me: oc.route({ method: 'GET', path: '/me' }).output(Tenant),
}

import type { Actor, OrgRole } from '../tenancy/access'
import { isOrgId } from '../tenancy/run-id'
import type { Auth } from './auth'

/**
 * Turns a request's sign-in cookie into the person it acts as and the organization they are
 * working in. Returns null when the request is not signed in.
 *
 * Everyone works inside an organization. A person with none (a new account) gets a personal one,
 * and a sign-in session with no active organization takes the person's first.
 */
export async function resolveActor(auth: Auth, request: Request): Promise<Actor | null> {
  const headers = request.headers
  const current = await auth.api.getSession({ headers })

  if (!current) {
    return null
  }

  const { user, session } = current
  const identity = { userId: user.id, name: user.name, email: user.email }

  if (isOrgId(session.activeOrganizationId)) {
    const member = await auth.api.getActiveMember({ headers }).catch(() => null)

    if (member) {
      return { ...identity, orgId: member.organizationId, role: orgRole(member.role) }
    }
  }

  // No active organization, or the person was removed from it since this session chose it.
  const organizations = await auth.api.listOrganizations({ headers })
  const first = organizations[0] ?? (await createPersonalOrganization(auth, user))

  await auth.api.setActiveOrganization({ body: { organizationId: first.id }, headers })
  const member = await auth.api.getActiveMember({ headers })

  if (!member) {
    return null
  }

  return { ...identity, orgId: member.organizationId, role: orgRole(member.role) }
}

async function createPersonalOrganization(
  auth: Auth,
  user: { id: string; name: string },
): Promise<{ id: string }> {
  const created = await auth.api.createOrganization({
    body: {
      name: `${user.name || 'My'} workspace`,
      slug: `personal-${user.id.toLowerCase()}`,
      userId: user.id,
    },
  })

  if (!created) {
    throw new Error('could not create an organization for this account')
  }

  return created
}

/** Better Auth stores one role, or several separated by commas. The strongest one counts. */
export function orgRole(role: string): OrgRole {
  const roles = role.split(',').map((part) => part.trim())

  if (roles.includes('owner')) {
    return 'owner'
  }

  return roles.includes('admin') ? 'admin' : 'member'
}

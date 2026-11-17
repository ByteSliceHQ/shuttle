import { peopleQuery, type ShuttlePerson } from '@/shuttle'

import { authClient } from './auth-client'

/**
 * Everyone in the signed-in organization. Sign-in keeps its own client, so this is not one of
 * the Worker's routes.
 */
export async function listOrgMembers(): Promise<readonly ShuttlePerson[]> {
  const listed = await authClient.organization.listMembers({ query: { limit: 1000 } })

  if (listed.error) {
    throw new Error(listed.error.message ?? 'Could not load the organization.')
  }

  return listed.data.members.map((member) => ({
    userId: member.userId,
    name: member.user.name,
    email: member.user.email,
  }))
}

/** The same query Shuttle's components read, for the app's loaders to fill ahead of them. */
export function orgMembersQuery(orgId: string) {
  return peopleQuery(orgId, listOrgMembers)
}

import { queryOptions, useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import { authClient } from './auth-client'
import { useTenant } from './tenant'

export interface OrgMember {
  readonly userId: string
  readonly name: string
  readonly email: string
}

/**
 * Everyone in the organization `orgId`. Sign-in keeps its own client, so this is not one of the
 * Worker's routes. Membership changes rarely, so one read serves the whole visit.
 */
export function orgMembersQuery(orgId: string) {
  return queryOptions({
    queryKey: ['org-members', orgId] as const,
    queryFn: async (): Promise<readonly OrgMember[]> => {
      const listed = await authClient.organization.listMembers({ query: { limit: 1000 } })

      if (listed.error) {
        throw new Error(listed.error.message ?? 'Could not load the organization.')
      }

      return listed.data.members.map((member) => ({
        userId: member.userId,
        name: member.user.name,
        email: member.user.email,
      }))
    },
    staleTime: 5 * 60_000,
  })
}

const nobody: ReadonlyMap<string, string> = new Map()

/** Names for the people in the signed-in organization, by user id. Empty until they load. */
export function useOrgPeople(): ReadonlyMap<string, string> {
  const { data } = useQuery(orgMembersQuery(useTenant().org.id))

  return useMemo(
    () =>
      data ? new Map(data.map((member) => [member.userId, member.name || member.email])) : nobody,
    [data],
  )
}

/** "your" for the signed-in person, "Alice's" for anyone else, "a teammate's" when unknown. */
export function possessive(
  userId: string,
  me: string,
  people: ReadonlyMap<string, string>,
): string {
  if (userId === me) {
    return 'your'
  }

  const name = people.get(userId)

  return name ? `${name}'s` : "a teammate's"
}

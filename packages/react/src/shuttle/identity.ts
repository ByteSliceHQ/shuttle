import { queryOptions } from '@tanstack/react-query'

import type { Tenant } from '@shuttle/api'

import { hasText } from '../lib/text'

export interface ShuttlePerson {
  readonly userId: string
  readonly name: string
  readonly email: string
}

/**
 * Who is using Shuttle, as the host knows them. Shuttle's components never sign anyone in or
 * ask who they are: the host has already settled that, and says so here.
 */
export interface ShuttleIdentity {
  /** The signed-in person, their organization, and the organization's runs. */
  readonly tenant: Tenant
  /** Everyone in the organization, for names, bylines and sharing. */
  readonly listPeople: () => Promise<readonly ShuttlePerson[]>
  /**
   * Sends the person off to connect their own GitHub account, for what is done in their name
   * (a review comment). A host that connects accounts some other way leaves it out, and the
   * components then only say that the account is not connected.
   */
  readonly connectGithub?: () => void
}

/**
 * Everyone in the organization `orgId`. Membership changes rarely, so one read serves the whole
 * visit. A host that reads it ahead of a page uses this too, so the page finds it there.
 */
export function peopleQuery(orgId: string, listPeople: ShuttleIdentity['listPeople']) {
  return queryOptions({
    queryKey: ['org-members', orgId] as const,
    queryFn: () => listPeople(),
    staleTime: 5 * 60_000,
  })
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

  return hasText(name) ? `${name}'s` : "a teammate's"
}

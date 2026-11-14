import { useEffect, useState } from 'react'

import { authClient } from './auth-client'
import { useTenant } from './tenant'

/** The names of the people in the organization, by user id. Loaded once per organization. */
const loaded = new Map<string, Promise<ReadonlyMap<string, string>>>()

function loadPeople(orgId: string): Promise<ReadonlyMap<string, string>> {
  const existing = loaded.get(orgId)

  if (existing) {
    return existing
  }

  const people = authClient.organization
    .listMembers({ query: { limit: 1000 } })
    .then(
      (listed) =>
        new Map(
          (listed.data?.members ?? []).map((member) => [
            member.userId,
            member.user.name || member.user.email,
          ]),
        ),
    )

  loaded.set(orgId, people)

  return people
}

const nobody: ReadonlyMap<string, string> = new Map()

/** Names for the people in the signed-in organization. Empty until they load. */
export function useOrgPeople(): ReadonlyMap<string, string> {
  const orgId = useTenant().org.id
  const [people, setPeople] = useState(nobody)

  useEffect(() => {
    let current = true

    void loadPeople(orgId).then((names) => {
      if (current) {
        setPeople(names)
      }
    })

    return () => {
      current = false
    }
  }, [orgId])

  return people
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

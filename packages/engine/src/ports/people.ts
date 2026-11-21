/**
 * Who is in an organization: the host port a session's sharing is checked against.
 *
 * A session is only ever shared with people in its own organization. Shuttle's own app asks its
 * sign-in store. A host that keeps people elsewhere answers from there. With no port nobody is
 * known, so a session can be made public or private and shared with no one.
 */
export interface PeoplePort {
  /** The ids of everyone in `orgId`. `request` is the one being answered, for a store that reads its sign-in. */
  members(orgId: string, request: Request): Promise<readonly string[]>
}

/** For a host that has not said who its people are: nobody is known. */
export const noPeople: PeoplePort = { members: async () => [] }

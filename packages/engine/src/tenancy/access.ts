import { z } from 'zod'

/**
 * Who may open a session. The record lives in the session's own Durable Object storage, so the
 * check that guards a request reads it from the object the request is about to reach.
 *
 * A session is private unless its owner says otherwise: only the owner and the people it is
 * shared with can open it, and nobody else in the organization learns that it exists. A public
 * session is open to the whole organization.
 *
 * A session with no record, or no owner (one Shuttle started itself, such as an automatic
 * review), is public.
 */

export const ACCESS_STORAGE_KEY = 'shuttle:access'

export type SessionVisibility = 'private' | 'public'

export interface SessionAccess {
  /** The person who started the session. Null when Shuttle started it. */
  readonly ownerId: string | null
  /** People the owner shared the session with. */
  readonly memberIds: readonly string[]
  readonly visibility: SessionVisibility
}

export type OrgRole = 'owner' | 'admin' | 'member'

/** The signed-in person a request acts as, in their active organization. */
export interface Actor {
  readonly userId: string
  readonly orgId: string
  readonly role: OrgRole
  readonly name: string
  readonly email: string
}

export interface AccessStorage {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: SessionAccess): Promise<void>
}

const UserIdSchema = z.string().min(1).max(128)

/** Decodes a stored or submitted access record into a normalized `SessionAccess`. */
export const SessionAccessSchema = z
  .object({
    ownerId: z.union([z.null(), UserIdSchema]),
    // Entries that are not valid person ids are dropped rather than failing the whole record.
    memberIds: z.array(z.unknown()).transform((entries) =>
      entries.flatMap((entry) => {
        const id = UserIdSchema.safeParse(entry)

        return id.success ? [id.data] : []
      }),
    ),
    visibility: z.unknown().optional(),
  })
  .transform(({ ownerId, memberIds, visibility }): SessionAccess => ({
    ownerId,
    memberIds: [...new Set(memberIds)].filter((id) => id !== ownerId),
    // Without an owner there is no one a session could be private to.
    visibility: ownerId !== null && visibility !== 'public' ? 'private' : 'public',
  }))

/** Whether everyone in the organization can open the session. */
export function isPublicSession(access: SessionAccess | null): boolean {
  return access === null || access.visibility === 'public'
}

export async function readSessionAccess(storage: AccessStorage): Promise<SessionAccess | null> {
  const parsed = SessionAccessSchema.safeParse(await storage.get(ACCESS_STORAGE_KEY))

  return parsed.success ? parsed.data : null
}

export async function writeSessionAccess(
  storage: AccessStorage,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: this is the validation boundary for access values; `SessionAccessSchema` decodes it on the next line before use, and the tests feed it malformed input on purpose.
  value: unknown,
): Promise<SessionAccess> {
  const parsed = SessionAccessSchema.safeParse(value)

  if (!parsed.success) {
    throw new Error('invalid session access')
  }

  await storage.put(ACCESS_STORAGE_KEY, parsed.data)
  return parsed.data
}

export function isOrgAdmin(actor: Pick<Actor, 'role'>): boolean {
  return actor.role === 'owner' || actor.role === 'admin'
}

/** A private session opens for its owner and its members only. Admins get no exception. */
export function canOpenSession(
  access: SessionAccess | null,
  actor: Pick<Actor, 'userId'>,
): boolean {
  if (access === null || isPublicSession(access)) {
    return true
  }

  return access.ownerId === actor.userId || access.memberIds.includes(actor.userId)
}

/** Only the owner decides who else may open a session. */
export function canShareSession(
  access: SessionAccess | null,
  actor: Pick<Actor, 'userId'>,
): boolean {
  return access !== null && access.ownerId !== null && access.ownerId === actor.userId
}

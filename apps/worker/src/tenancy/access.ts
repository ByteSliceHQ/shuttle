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

type AccessStorage = Pick<DurableObjectStorage, 'get' | 'put'>

function isUserId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}

export function parseSessionAccess(value: unknown): SessionAccess | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const record = value as { ownerId?: unknown; memberIds?: unknown; visibility?: unknown }

  const ownerId =
    record.ownerId === null ? null : isUserId(record.ownerId) ? record.ownerId : undefined

  if (ownerId === undefined || !Array.isArray(record.memberIds)) {
    return null
  }

  return {
    ownerId,
    memberIds: [...new Set(record.memberIds.filter(isUserId))].filter((id) => id !== ownerId),
    // Without an owner there is no one a session could be private to.
    visibility: ownerId !== null && record.visibility !== 'public' ? 'private' : 'public',
  }
}

/** Whether everyone in the organization can open the session. */
export function isPublicSession(access: SessionAccess | null): boolean {
  return !access || access.visibility === 'public'
}

export async function readSessionAccess(storage: AccessStorage): Promise<SessionAccess | null> {
  return parseSessionAccess(await storage.get(ACCESS_STORAGE_KEY))
}

export async function writeSessionAccess(
  storage: AccessStorage,
  value: unknown,
): Promise<SessionAccess> {
  const access = parseSessionAccess(value)

  if (!access) {
    throw new Error('invalid session access')
  }

  await storage.put(ACCESS_STORAGE_KEY, access)
  return access
}

export function isOrgAdmin(actor: Pick<Actor, 'role'>): boolean {
  return actor.role === 'owner' || actor.role === 'admin'
}

/** A private session opens for its owner and its members only. Admins get no exception. */
export function canOpenSession(
  access: SessionAccess | null,
  actor: Pick<Actor, 'userId'>,
): boolean {
  if (!access || isPublicSession(access)) {
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

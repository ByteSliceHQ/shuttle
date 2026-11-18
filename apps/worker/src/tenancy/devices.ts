/**
 * Machines: the computers people run a local sandbox on, and the tokens their runners sign in
 * with.
 *
 * A runner is not a browser, and should not carry a person's sign-in. Registering a machine
 * makes a token for it that can do one thing: connect that machine's runner as that person in
 * that organization. Removing the machine ends the token. The token is shown once, when it is
 * made, and only its hash is stored.
 */

const TOKEN_PREFIX = 'shr_'

export interface Device {
  readonly orgId: string
  readonly userId: string
  readonly deviceId: string
  readonly name: string
  readonly platform: string
  readonly createdAt: number
}

interface DeviceRow {
  readonly org_id: string
  readonly user_id: string
  readonly device_id: string
  readonly name: string
  readonly platform: string
  readonly created_at: number
}

function deviceOf(row: DeviceRow): Device {
  return {
    orgId: row.org_id,
    userId: row.user_id,
    deviceId: row.device_id,
    name: row.name,
    platform: row.platform,
    createdAt: row.created_at,
  }
}

async function hashOf(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))

  return TOKEN_PREFIX + Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Registers a person's machine and returns its token. Registering a machine again replaces the
 * token it had, which stops working at once.
 */
export async function registerDevice(
  db: D1Database,
  device: Omit<Device, 'createdAt'>,
  now = Date.now(),
): Promise<{ token: string }> {
  const token = newToken()

  await db
    .prepare(
      `insert into "shuttle_runner_device"
         ("org_id", "user_id", "device_id", "name", "platform", "token_hash", "created_at")
       values (?, ?, ?, ?, ?, ?, ?)
       on conflict ("org_id", "user_id", "device_id") do update set
         "name" = excluded."name",
         "platform" = excluded."platform",
         "token_hash" = excluded."token_hash"`,
    )
    .bind(
      device.orgId,
      device.userId,
      device.deviceId,
      device.name.slice(0, 120),
      device.platform.slice(0, 40),
      await hashOf(token),
      now,
    )
    .run()

  return { token }
}

/** The machine a runner's token belongs to, or null for anything that is not one. */
export async function deviceOfToken(db: D1Database, token: string): Promise<Device | null> {
  if (!token.startsWith(TOKEN_PREFIX)) {
    return null
  }

  const row = await db
    .prepare(`select * from "shuttle_runner_device" where "token_hash" = ?`)
    .bind(await hashOf(token))
    .first<DeviceRow>()

  return row ? deviceOf(row) : null
}

/** A person's machines in an organization, oldest first. */
export async function listDevices(
  db: D1Database,
  orgId: string,
  userId: string,
): Promise<Device[]> {
  const { results } = await db
    .prepare(
      `select * from "shuttle_runner_device"
       where "org_id" = ? and "user_id" = ? order by "created_at", "device_id"`,
    )
    .bind(orgId, userId)
    .all<DeviceRow>()

  return results.map(deviceOf)
}

/** Forgets a machine, which ends its token. Returns whether there was one. */
export async function removeDevice(
  db: D1Database,
  orgId: string,
  userId: string,
  deviceId: string,
): Promise<boolean> {
  const done = await db
    .prepare(
      `delete from "shuttle_runner_device"
       where "org_id" = ? and "user_id" = ? and "device_id" = ?`,
    )
    .bind(orgId, userId, deviceId)
    .run()

  return done.meta.changes > 0
}

/** The token a request carries as `Authorization: Bearer …`, if it carries one. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization') ?? ''

  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null
}

/**
 * Which organizations a GitHub App installation is connected to.
 *
 * The App's credentials can reach every installation, so nothing may act on an installation id
 * from a request until this table says the caller's organization connected it. One installation
 * may be connected to several organizations: the same GitHub organization is often wanted in
 * more than one Shuttle organization, by people GitHub says can access it.
 */

const TABLE = '"shuttle_github_installation_org"'

/**
 * Connects the installation to `orgId`, alongside any organization that already has it. Use it
 * only where GitHub has confirmed the person can access the installation.
 */
export async function connectInstallation(
  db: D1Database,
  installationId: number,
  orgId: string,
  now = Date.now(),
): Promise<void> {
  await db
    .prepare(
      `insert into ${TABLE} ("installation_id", "org_id", "created_at")
       values (?, ?, ?) on conflict ("installation_id", "org_id") do nothing`,
    )
    .bind(installationId, orgId, now)
    .run()
}

/**
 * Connects the installation to `orgId` only if no other organization has it. Returns whether
 * `orgId` has it afterwards.
 *
 * This is for the one path where nothing proves the person can access the installation: GitHub's
 * post-install redirect, used when the App has no client id and secret to identify them with.
 * There, an installation id in a URL is all there is, so only an unclaimed one may be taken.
 */
export async function claimInstallation(
  db: D1Database,
  installationId: number,
  orgId: string,
  now = Date.now(),
): Promise<boolean> {
  const owners = await orgsOfInstallation(db, installationId)

  if (owners.length > 0) {
    return owners.includes(orgId)
  }

  await connectInstallation(db, installationId, orgId, now)

  return true
}

/** Every organization the installation is connected to. */
export async function orgsOfInstallation(
  db: D1Database,
  installationId: number,
): Promise<string[]> {
  const { results } = await db
    .prepare(`select "org_id" from ${TABLE} where "installation_id" = ? order by "created_at"`)
    .bind(installationId)
    .all<{ org_id: string }>()

  return results.map((row) => row.org_id)
}

/** Whether `orgId` connected the installation, and so may use it. */
export async function installationConnected(
  db: D1Database,
  installationId: number,
  orgId: string,
): Promise<boolean> {
  const row = await db
    .prepare(`select 1 as "found" from ${TABLE} where "installation_id" = ? and "org_id" = ?`)
    .bind(installationId, orgId)
    .first<{ found: number }>()

  return row !== null
}

/** Disconnects the installation from `orgId`. Other organizations keep it. */
export async function disconnectInstallation(
  db: D1Database,
  installationId: number,
  orgId: string,
): Promise<void> {
  await db
    .prepare(`delete from ${TABLE} where "installation_id" = ? and "org_id" = ?`)
    .bind(installationId, orgId)
    .run()
}

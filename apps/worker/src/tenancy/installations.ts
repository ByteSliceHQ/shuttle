/**
 * Which organization a GitHub App installation is connected to.
 *
 * The App's credentials can reach every installation, so nothing may act on an installation id
 * from a request until this table says it belongs to the caller's organization.
 */

/** Connects the installation to `orgId` unless another organization has it. Returns its owner. */
export async function bindInstallation(
  db: D1Database,
  installationId: number,
  orgId: string,
  now = Date.now(),
): Promise<string> {
  await db
    .prepare(
      `insert into "shuttle_github_installation" ("installation_id", "org_id", "created_at")
       values (?, ?, ?) on conflict ("installation_id") do nothing`,
    )
    .bind(installationId, orgId, now)
    .run()

  return (await orgOfInstallation(db, installationId)) ?? orgId
}

export async function orgOfInstallation(
  db: D1Database,
  installationId: number,
): Promise<string | null> {
  const row = await db
    .prepare(`select "org_id" from "shuttle_github_installation" where "installation_id" = ?`)
    .bind(installationId)
    .first<{ org_id: string }>()

  return row?.org_id ?? null
}

export async function unbindInstallation(
  db: D1Database,
  installationId: number,
  orgId: string,
): Promise<void> {
  await db
    .prepare(
      `delete from "shuttle_github_installation" where "installation_id" = ? and "org_id" = ?`,
    )
    .bind(installationId, orgId)
    .run()
}

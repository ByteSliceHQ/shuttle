/**
 * Settings a deployment may keep readable on the Worker. Anything else in `SHUTTLE_DEPLOY_VARS`
 * becomes a secret, so a credential added there stays secret while nobody updates this list.
 */
export const PUBLIC_DEPLOY_VARS: ReadonlySet<string> = new Set([
  'DAYTONA_API_URL',
  'DAYTONA_SNAPSHOT',
  'DAYTONA_TARGET',
  'GITHUB_APP_ID',
  'GITHUB_APP_SLUG',
  'GITHUB_CLIENT_ID',
  'JEV_MODEL',
  'LOOMS_MODEL',
  'PIERRE_ORG',
  'SHUTTLE_PLAYBOOK_RUN_ID',
  'SHUTTLE_PREVIEW_HOST',
  'SHUTTLE_PULLS_RUN_ID',
  'SHUTTLE_WEB_URL',
  'SHUTTLE_WORKSPACE_MODE',
  'SHUTTLE_WORKSPACE_RUN_ID',
])

export interface DeployVarSplit {
  /** Values that go in the generated config's `vars`. */
  readonly vars: Record<string, string>
  /** Values that go in the secrets file, which the deploy uploads as `secret_text` bindings. */
  readonly secrets: Record<string, string>
}

export function splitDeployVars(overrides: Record<string, string>): DeployVarSplit {
  const vars: Record<string, string> = {}
  const secrets: Record<string, string> = {}

  for (const [name, value] of Object.entries(overrides)) {
    if (PUBLIC_DEPLOY_VARS.has(name)) {
      vars[name] = value
    } else {
      secrets[name] = value
    }
  }

  return { vars, secrets }
}

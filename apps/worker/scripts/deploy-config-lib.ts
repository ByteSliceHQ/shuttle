import { isLocal } from '@shuttle/sandbox/https'

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

/** A wrangler route, as `SHUTTLE_DEPLOY_ROUTES` declares it. `pattern` decides the preview host. */
export interface DeployRoute {
  readonly pattern: string
}

/** The domain a deployment answers on through its wildcard route, such as `*.shuttle.codes`. */
export function previewHostFromRoutes(routes: readonly DeployRoute[]): string | null {
  const hosts = new Set<string>()

  for (const route of routes) {
    const match = route.pattern.match(/^\*\.([^/*]+)/)

    if (match?.[1] !== undefined) {
      hosts.add(match[1])
    }
  }

  if (hosts.size !== 1) {
    return null
  }

  for (const host of hosts) {
    return host
  }

  return null
}

/** Sandbox modes whose machines serve port previews. A `memory` sandbox has no machine. */
const PREVIEW_MODES: ReadonlySet<string> = new Set(['container', 'cloudflare', 'daytona'])

/**
 * The hostname a deployment serves previews under. `wrangler.jsonc` keeps `localhost` for
 * development, where `*.localhost` resolves to loopback; a routed deployment puts previews under
 * the domain of its wildcard route, because the development default points a visitor's browser at
 * the visitor's own machine.
 */
export function deploymentPreviewHost(
  current: string | undefined,
  routes: readonly DeployRoute[],
  mode: string | undefined,
): string {
  const host = current ?? ''

  if (
    !PREVIEW_MODES.has(mode ?? 'memory') ||
    routes.length === 0 ||
    (host !== '' && !isLocal(host))
  ) {
    return host
  }

  const derived = previewHostFromRoutes(routes)

  if (derived === null) {
    throw new Error(
      'SHUTTLE_PREVIEW_HOST is a development default and this deployment routes no single wildcard host to derive it from. Set SHUTTLE_PREVIEW_HOST in SHUTTLE_DEPLOY_VARS to the host previews are served under.',
    )
  }

  return derived
}

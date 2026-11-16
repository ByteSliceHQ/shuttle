/**
 * Names of sandbox Durable Objects, and what a name says about where the sandbox runs.
 *
 * A folder's sandbox is `folder:<folderId>`; on Daytona each person has one of their own in each
 * organization, `user:<orgId>:<userId>`. A sandbox on a person's own machine is
 * `local:<orgId>:<userId>:<deviceId>`, whatever the deployment runs its other sandboxes on.
 */

/** The providers a sandbox can run on. See `providers/registry.ts`. */
export type SandboxProviderId = 'memory' | 'cloudflare' | 'daytona' | 'local'

/** The sandbox a person keeps on one of their own machines. */
export function localSandboxName(orgId: string, userId: string, deviceId: string): string {
  return `local:${orgId}:${userId}:${deviceId}`
}

/** Whether the sandbox runs on a person's own machine. */
export function isLocalSandbox(sandboxName: string): boolean {
  return sandboxName.startsWith('local:')
}

/** The machine a local sandbox runs on. Null for any other sandbox. */
export function deviceOfSandbox(sandboxName: string): string | null {
  const [kind, , , deviceId] = sandboxName.split(':')

  return kind === 'local' && deviceId ? deviceId : null
}

/**
 * The provider a sandbox runs on. A local sandbox says so in its name; every other sandbox runs
 * on the deployment's provider, `SHUTTLE_WORKSPACE_MODE` (`container` is Cloudflare's).
 */
export function providerIdForSandbox(
  sandboxName: string,
  env: { readonly SHUTTLE_WORKSPACE_MODE?: string },
): SandboxProviderId {
  if (isLocalSandbox(sandboxName)) {
    return 'local'
  }

  switch (env.SHUTTLE_WORKSPACE_MODE) {
    case 'container':
    case 'cloudflare':
      return 'cloudflare'
    case 'daytona':
      return 'daytona'
    default:
      return 'memory'
  }
}

/**
 * Whether a session's work can be carried into or out of this sandbox. It travels as git
 * branches, which a sandbox with no machine behind it cannot push or fetch.
 */
export function sandboxCarriesWork(
  sandboxName: string,
  env: { readonly SHUTTLE_WORKSPACE_MODE?: string },
): boolean {
  return providerIdForSandbox(sandboxName, env) !== 'memory'
}

/** Whether this sandbox is one person's, with their sign-ins in it. */
export function sandboxIsPersonal(
  sandboxName: string,
  env: { readonly SHUTTLE_WORKSPACE_MODE?: string },
): boolean {
  return isLocalSandbox(sandboxName) || sandboxesArePersonal(env)
}

/** The sandbox that belongs to one person in an organization. */
export function userSandboxName(orgId: string, userId: string): string {
  return `user:${orgId}:${userId}`
}

/** The organization a person's sandbox belongs to. Null for a sandbox that is not a person's. */
export function orgOfSandbox(sandboxName: string): string | null {
  const [kind, orgId, userId] = sandboxName.split(':')

  return (kind === 'user' || kind === 'local') && orgId && userId ? orgId : null
}

/** The person a sandbox belongs to. Null for a sandbox that is not a person's. */
export function userOfSandbox(sandboxName: string): string | null {
  const [kind, orgId, userId] = sandboxName.split(':')

  return (kind === 'user' || kind === 'local') && orgId && userId ? userId : null
}

/** Whether the deployment's own sandboxes are per person, which they are on Daytona. */
export function sandboxesArePersonal(env: { readonly SHUTTLE_WORKSPACE_MODE?: string }): boolean {
  return env.SHUTTLE_WORKSPACE_MODE === 'daytona'
}

/**
 * The repository a session works in when its folder has none linked: a small local one the
 * sandbox seeds for itself. It has no GitHub repository behind it.
 */
export const DEMO_REPO = {
  installationId: 0,
  owner: '',
  name: 'demo',
  fullName: '',
  defaultBranch: 'main',
  private: true,
} as const

/** Whether `repo` is the seeded demo repository and not a linked GitHub one. */
export function isDemoRepo(repo: { readonly fullName: string }): boolean {
  return repo.fullName === ''
}

/**
 * Names of sandbox Durable Objects. A folder's sandbox is `folder:<folderId>`; on Daytona each
 * person has one of their own in each organization, `user:<orgId>:<userId>`.
 */

/** The sandbox that belongs to one person in an organization. */
export function userSandboxName(orgId: string, userId: string): string {
  return `user:${orgId}:${userId}`
}

/** The organization a person's sandbox belongs to. Null for a sandbox that is not a person's. */
export function orgOfSandbox(sandboxName: string): string | null {
  const [kind, orgId, userId] = sandboxName.split(':')

  return kind === 'user' && orgId && userId ? orgId : null
}

/** The person a sandbox belongs to. Null for a sandbox that is not a person's. */
export function userOfSandbox(sandboxName: string): string | null {
  const [kind, orgId, userId] = sandboxName.split(':')

  return kind === 'user' && orgId && userId ? userId : null
}

/** Whether sandboxes are per person, which they are on Daytona. */
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

import { NotFoundError, Pierre } from '@pierre/sdk'
import { createToken, type RefPolicy } from '@pierre/sdk/auth'

import type { ShuttleEnv } from '../env'

/**
 * Code Storage serves repositories to sandboxes. Each linked GitHub repository has a Code Storage
 * repository that stays in sync with it, and a session's work in progress lives there on branches
 * GitHub never sees.
 *
 * Sandboxes get short-lived tokens for one repository. GitHub credentials never enter a sandbox.
 */

type CodeStorageEnv = Pick<ShuttleEnv, 'PIERRE_ORG' | 'PIERRE_PRIVATE_KEY'>

/** Longest a token may live, in seconds. Code Storage's own limit. */
export const TOKEN_TTL_SECONDS = 3600

/** Where Code Storage keeps branches that are never mirrored to GitHub. */
const EPHEMERAL_REFS = 'refs/namespaces/ephemeral/refs/heads/'

export function codeStorageConfigured(env: CodeStorageEnv): boolean {
  return (env.PIERRE_ORG?.trim() ?? '') !== '' && (env.PIERRE_PRIVATE_KEY?.trim() ?? '') !== ''
}

/**
 * Code Storage cannot mirror GitHub repositories until the GitHub App is connected in the Code
 * Storage organization's Integrations tab.
 */
export class GithubSyncNotConfiguredError extends Error {
  constructor() {
    super(
      'Code Storage has no GitHub App connected, so it cannot mirror GitHub repositories. Connect ' +
        "the App in the Code Storage organization's Integrations tab.",
    )

    this.name = 'GithubSyncNotConfiguredError'
  }
}

/** The private key as PEM. A key pasted on one line carries its line breaks as `\n`. */
function privateKey(env: CodeStorageEnv): string {
  return (env.PIERRE_PRIVATE_KEY ?? '').trim().replaceAll(String.raw`\n`, '\n')
}

export function codeStorageClient(env: CodeStorageEnv): Pierre {
  if (!codeStorageConfigured(env)) {
    throw new Error('PIERRE_ORG and PIERRE_PRIVATE_KEY are not set; Code Storage is unavailable')
  }

  return new Pierre({ org: env.PIERRE_ORG?.trim(), privateKey: privateKey(env) })
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
}

/**
 * The Code Storage repository for a GitHub repository linked in a Shuttle organization. Each
 * organization gets its own, so one organization's session branches are never in a repository
 * another organization's sandboxes can read.
 */
export function codeStorageRepoName(orgId: string, fullName: string): string {
  const [owner = '', name = ''] = fullName.split('/')

  // Organization ids differ only by case in places, so the id is kept as it is.
  return `org-${orgId}/${slug(owner)}--${slug(name)}`
}

/**
 * The Code Storage repository that carries a session with no linked GitHub repository between
 * sandboxes. It mirrors nothing and holds only that session.
 */
export function scratchRepoName(orgId: string, runId: string): string {
  // The run id starts with its organization, which the name already has.
  const local = runId.startsWith(`o-${orgId}-`) ? runId.slice(orgId.length + 3) : runId

  return `org-${orgId}/scratch--${slug(local)}`
}

/** Makes sure a session's scratch repository exists. It syncs with nothing. */
export async function ensureScratchRepo(client: Pierre, repoName: string): Promise<void> {
  try {
    await client.repos.get({ repo_name: repoName })
  } catch (cause) {
    if (!(cause instanceof NotFoundError)) {
      throw cause
    }

    await client.repos.create({ repo_name: repoName, default_branch: 'main' })
  }
}

/** Deletes a session's scratch repository. Does nothing if it never had one. */
export async function deleteScratchRepo(client: Pierre, repoName: string): Promise<void> {
  try {
    await client.repos.delete({ repo_name: repoName })
  } catch (cause) {
    if (!(cause instanceof NotFoundError)) {
      throw cause
    }
  }
}

/** The ephemeral branch prefix that holds one session's work. */
export function sessionBranchPrefix(runId: string): string {
  return `sessions/${runId}/`
}

/**
 * What a session's token may push: only its own ephemeral branches. Everything else in the
 * repository, including every normal branch and every other session's, is read-only to it.
 */
export function sessionRefPolicies(runId: string): RefPolicy[] {
  return [
    { pattern: `${EPHEMERAL_REFS}${sessionBranchPrefix(runId)}*` },
    { pattern: '*', ops: ['no-push'] },
  ]
}

/** The repository's git URL, without credentials. `ephemeral` selects the unmirrored branches. */
export function codeStorageGitUrl(
  env: CodeStorageEnv,
  repoName: string,
  kind: 'default' | 'ephemeral' = 'default',
): string {
  const host = `${env.PIERRE_ORG?.trim()}.code.storage`

  return `https://${host}/${repoName}${kind === 'ephemeral' ? '+ephemeral' : ''}.git`
}

/** The value of an `Authorization: Basic` header that carries `token` to Code Storage over git. */
export function gitBasicAuth(token: string): string {
  return btoa(`t:${token}`)
}

/**
 * Makes sure the Code Storage repository that mirrors a GitHub repository exists. Syncing reads
 * through the GitHub App connected to the Code Storage organization.
 */
export async function ensureCodeStorageRepo(
  client: Pierre,
  repoName: string,
  github: { readonly owner: string; readonly name: string; readonly defaultBranch: string },
): Promise<void> {
  try {
    await client.repos.get({ repo_name: repoName })
  } catch (cause) {
    if (!(cause instanceof NotFoundError)) {
      throw cause
    }

    try {
      await client.repos.create({
        repo_name: repoName,
        default_branch: github.defaultBranch,
        upstream: { provider: 'github', owner: github.owner, name: github.name },
      })
    } catch (created) {
      if (created instanceof Error && created.message.includes('github_app_not_configured')) {
        throw new GithubSyncNotConfiguredError()
      }

      throw created
    }

    return
  }

  // Code Storage is not sent GitHub's webhooks, so the mirror is asked to catch up whenever a
  // sandbox is about to read it. The refresh runs in the background on their side.
  await client.repos.upstream.pull({ repo_name: repoName }).catch(() => {})
}

/** A token to read a repository: clone and fetch. */
export function readToken(client: Pierre, repoName: string, subject: string): Promise<string> {
  return createToken(client, {
    scopes: ['git:read'],
    repo: repoName,
    ttl: TOKEN_TTL_SECONDS,
    subject,
  })
}

/** A token to read a repository and push one session's ephemeral branches. */
export function sessionToken(client: Pierre, repoName: string, runId: string): Promise<string> {
  return createToken(client, {
    scopes: ['git:read', 'git:write'],
    repo: repoName,
    ttl: TOKEN_TTL_SECONDS,
    ref_policies: sessionRefPolicies(runId),
    subject: `session:${runId}`.slice(0, 128),
  })
}

import {
  codeStorageClient,
  codeStorageConfigured,
  codeStorageGitUrl,
  codeStorageRepoName,
  ensureCodeStorageRepo,
  ensureScratchRepo,
  gitBasicAuth,
  GithubSyncNotConfiguredError,
  readToken,
  scratchRepoName,
  sessionToken,
} from '../codestorage/client'
import type { ShuttleEnv } from '../env'
import { getInstallationToken } from '../github/app'
import { isDemoRepo } from './names'
import type { LinkedSandboxRepo } from './workspace'

/** Where a sandbox clones a repository from, and the credential for that one request. */
export interface RepoAccess {
  /** The clone URL. It holds no credential, so it is safe to store as the remote. */
  readonly url: string
  /** Sent as `Authorization: Basic …` on each git command. Never written to disk. */
  readonly basicAuth: string
}

const githubUrl = (repo: LinkedSandboxRepo) => `https://github.com/${repo.fullName}.git`

/**
 * Every URL a sandbox may have cloned `repo` from. A checkout whose origin is one of these is the
 * same repository, wherever it was read from at the time.
 */
export function repoUrls(env: ShuttleEnv, repo: LinkedSandboxRepo, orgId: string | null): string[] {
  return [
    githubUrl(repo),
    ...(orgId !== null && orgId !== '' && codeStorageConfigured(env)
      ? [codeStorageGitUrl(env, codeStorageRepoName(orgId, repo.fullName))]
      : []),
  ]
}

/** Repositories already reported as having no mirror, so the log says it once each. */
const reportedUnmirrored = new Set<string>()

/**
 * Makes sure the organization's mirror of `repo` exists. False when Code Storage cannot mirror
 * GitHub repositories yet, which is a setup step in Code Storage and nothing a session can fix.
 */
async function mirrorReady(
  client: ReturnType<typeof codeStorageClient>,
  repoName: string,
  repo: LinkedSandboxRepo,
): Promise<boolean> {
  try {
    await ensureCodeStorageRepo(client, repoName, repo)

    return true
  } catch (cause) {
    if (!(cause instanceof GithubSyncNotConfiguredError)) {
      throw cause
    }

    if (!reportedUnmirrored.has(repoName)) {
      reportedUnmirrored.add(repoName)

      console.warn(
        `[code-storage] ${repo.fullName} is read from GitHub directly, and session work is saved to a repository per session: ${cause.message}`,
      )
    }

    return false
  }
}

/**
 * How a sandbox reaches a linked repository. A sandbox that belongs to an organization, with Code
 * Storage configured, reads the organization's mirror of the repository there, on a token that
 * can do nothing else. Any other sandbox reads GitHub directly on the App's installation token.
 */
export async function repoAccess(
  env: ShuttleEnv,
  repo: LinkedSandboxRepo,
  orgId: string | null,
): Promise<RepoAccess> {
  if (orgId !== null && orgId !== '' && codeStorageConfigured(env)) {
    const client = codeStorageClient(env)
    const repoName = codeStorageRepoName(orgId, repo.fullName)

    // Without the mirror a session still works, reading GitHub directly.
    if (await mirrorReady(client, repoName, repo)) {
      return {
        url: codeStorageGitUrl(env, repoName),
        basicAuth: gitBasicAuth(await readToken(client, repoName, 'sandbox-clone')),
      }
    }
  }

  const token = await getInstallationToken(env, repo.installationId)

  return { url: githubUrl(repo), basicAuth: btoa(`x-access-token:${token}`) }
}

/**
 * Where a session's work in progress is kept between sandboxes, on a token that may push only
 * that session's branches. A linked repository's work rides on the unmirrored branches of the
 * organization's mirror. A session with no linked repository, or whose repository has no mirror
 * yet, gets a Code Storage repository of its own that exists only to carry it. Null when Code
 * Storage is not configured.
 */
export async function sessionRemote(
  env: ShuttleEnv,
  repo: LinkedSandboxRepo,
  orgId: string | null,
  runId: string,
): Promise<RepoAccess | null> {
  if (orgId === null || orgId === '' || !codeStorageConfigured(env)) {
    return null
  }

  const client = codeStorageClient(env)
  const mirror = codeStorageRepoName(orgId, repo.fullName)
  const mirrored = !isDemoRepo(repo) && (await mirrorReady(client, mirror, repo))
  const repoName = mirrored ? mirror : scratchRepoName(orgId, runId)

  if (!mirrored) {
    await ensureScratchRepo(client, repoName)
  }

  return {
    url: codeStorageGitUrl(env, repoName, 'ephemeral'),
    basicAuth: gitBasicAuth(await sessionToken(client, repoName, runId)),
  }
}

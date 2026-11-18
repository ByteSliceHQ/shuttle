import type { ShuttleEnv } from '../env'
import { getInstallation, GithubGraphqlError } from '../github/client'
import { listOpenPulls, type PullSummary } from '../github/pulls'
import type { LoomsRunStub } from '../looms-stub'
import type { LinkedRepo } from '../workspace/scope'
import { upsertPull } from './signals'

/** Read access the inbox needs; GitHub hides private-repo PRs and checks without them. */
export const PULL_INBOX_PERMISSIONS = [
  { key: 'pull_requests', label: 'Pull requests' },
  { key: 'checks', label: 'Checks' },
  { key: 'statuses', label: 'Commit statuses' },
] as const

export type RepoSyncStatus = 'ok' | 'forbidden' | 'failed'

export interface RepoSyncReport {
  readonly fullName: string
  readonly status: RepoSyncStatus
  /** Open PRs GitHub reports for the repo. */
  readonly open: number
  /** Open PRs Shuttle ingested (capped per repo). */
  readonly synced: number
  readonly checksHidden: boolean
  readonly message: string | null
}

export interface InstallationAccessReport {
  readonly installationId: number
  readonly account: string
  readonly missingPermissions: readonly string[]
  readonly settingsUrl: string
}

export interface FolderSyncReport {
  readonly folderId: string
  readonly upserted: number
  readonly repos: readonly RepoSyncReport[]
  readonly installations: readonly InstallationAccessReport[]
}

type PullSignalSink = Pick<LoomsRunStub, 'signal'>

const SIGNAL_BATCH = 25

export function missingPullPermissions(permissions: Readonly<Record<string, string>>): string[] {
  return PULL_INBOX_PERMISSIONS.filter(({ key }) => (permissions[key] ?? '') === '').map(
    ({ label }) => label,
  )
}

export function classifySyncError(cause: unknown): Pick<RepoSyncReport, 'status' | 'message'> {
  const message = cause instanceof Error ? cause.message : String(cause)

  const forbidden =
    (cause instanceof GithubGraphqlError && cause.types.includes('FORBIDDEN')) ||
    /resource not accessible by integration/i.test(message)

  if (forbidden) {
    return {
      status: 'forbidden',
      message: 'The GitHub App cannot read pull requests in this repository.',
    }
  }

  return { status: 'failed', message }
}

function toUpsertSignal(pull: PullSummary) {
  return upsertPull({
    installationId: pull.installationId,
    fullName: pull.fullName,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    url: pull.url,
    draft: pull.draft,
    author: { login: pull.authorLogin, avatarUrl: pull.authorAvatarUrl },
    headRef: pull.headRef,
    headSha: pull.headSha,
    baseRef: pull.baseRef,
    baseSha: pull.baseSha,
    additions: pull.additions,
    deletions: pull.deletions,
    reviewDecision: pull.reviewDecision,
    checkRollup: pull.checkRollup,
    updatedAt: pull.updatedAt,
    isFork: pull.isFork,
    state: pull.state,
    stack: pull.stack,
  })
}

async function syncRepo(
  env: ShuttleEnv,
  sink: PullSignalSink,
  repo: LinkedRepo,
): Promise<RepoSyncReport> {
  try {
    const result = await listOpenPulls(env, repo)
    const signals = result.pulls.map(toUpsertSignal)

    for (let index = 0; index < signals.length; index += SIGNAL_BATCH) {
      await sink.signal(signals.slice(index, index + SIGNAL_BATCH))
    }

    return {
      fullName: repo.fullName,
      status: 'ok',
      open: result.totalCount,
      synced: result.pulls.length,
      checksHidden: result.checksHidden,
      message: null,
    }
  } catch (cause) {
    return {
      fullName: repo.fullName,
      open: 0,
      synced: 0,
      checksHidden: false,
      ...classifySyncError(cause),
    }
  }
}

async function installationAccess(
  env: ShuttleEnv,
  installationId: number,
): Promise<InstallationAccessReport | null> {
  const installation = await getInstallation(env, installationId).catch(() => null)

  if (!installation) {
    return null
  }

  return {
    installationId,
    account: installation.account.login,
    missingPermissions: missingPullPermissions(installation.permissions),
    settingsUrl: installation.htmlUrl,
  }
}

/** Pull every open PR on the folder's repos, one repo at a time so one failure stays local. */
export async function syncFolderRepos(
  env: ShuttleEnv,
  sink: PullSignalSink,
  folderId: string,
  repos: readonly LinkedRepo[],
): Promise<FolderSyncReport> {
  const reports = await Promise.all(repos.map((repo) => syncRepo(env, sink, repo)))
  const installationIds = [...new Set(repos.map((repo) => repo.installationId))]

  const installations = (
    await Promise.all(installationIds.map((id) => installationAccess(env, id)))
  ).filter((entry): entry is InstallationAccessReport => entry !== null)

  return {
    folderId,
    upserted: reports.reduce((sum, report) => sum + report.synced, 0),
    repos: reports,
    installations,
  }
}

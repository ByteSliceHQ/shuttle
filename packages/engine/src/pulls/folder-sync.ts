import { Schema } from 'effect'

import { getInstallation, GithubGraphqlError } from '@shuttle/git/github/client'
import { listOpenPulls, type PullSummary } from '@shuttle/git/github/pulls'

import type { EngineEnv } from '../env'
import type { LoomsRunStub } from '../looms-stub'
import type { LinkedRepo } from '../workspace/scope'
import { PullInboxStateSchema, type PullInboxState, type PullInboxSummary } from './projections'
import { pullKey } from './scope'
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

type PullSignalSink = Pick<LoomsRunStub, 'fetch' | 'signal'>

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

/** What two copies of a pull request hold: everything the inbox mirrors from a fetch. */
const shape = (pull: {
  readonly installationId: number
  readonly title: string
  readonly body: string
  readonly url: string
  readonly state: 'open' | 'closed'
  readonly draft: boolean
  readonly author: { readonly login: string; readonly avatarUrl: string }
  readonly headRef: string
  readonly headSha: string
  readonly baseRef: string
  readonly baseSha: string
  readonly additions: number
  readonly deletions: number
  readonly reviewDecision: PullInboxSummary['reviewDecision']
  readonly checkRollup: PullInboxSummary['checkRollup']
  readonly isFork: boolean
  readonly stack: PullInboxSummary['stack']
}) =>
  JSON.stringify([
    pull.installationId,
    pull.title,
    pull.body,
    pull.url,
    pull.state,
    pull.draft,
    pull.author.login,
    pull.author.avatarUrl,
    pull.headRef,
    pull.headSha,
    pull.baseRef,
    pull.baseSha,
    pull.additions,
    pull.deletions,
    pull.reviewDecision,
    pull.checkRollup,
    pull.isFork,
    pull.stack?.number ?? null,
    pull.stack?.position ?? null,
    pull.stack?.size ?? null,
  ])

/**
 * Whether a fetch adds nothing the inbox does not already hold. A checks or review event moves the
 * mirrored `updatedAt` past GitHub's own, so an equal copy is compared without it, and an older
 * fetch is skipped because the pulls run drops any event the newer copy already passed.
 */
export function alreadyRecorded(
  known: PullInboxSummary | undefined,
  fetched: PullSummary,
): boolean {
  if (known === undefined) {
    return false
  }

  if (fetched.updatedAt !== known.updatedAt) {
    return fetched.updatedAt < known.updatedAt
  }

  return (
    shape(known) ===
    shape({ ...fetched, author: { login: fetched.authorLogin, avatarUrl: fetched.authorAvatarUrl } })
  )
}

const ProjectionBodySchema = Schema.Struct({ value: Schema.optional(PullInboxStateSchema) })

/** Every pull request the inbox already mirrors, so a sync records only what changed. */
async function knownPulls(
  sink: PullSignalSink,
  runId: string,
): Promise<PullInboxState['pulls']> {
  const response = await sink
    .fetch(
      new Request(`https://shuttle.internal/runs/${runId}/projections/pullInbox`, {
        method: 'GET',
      }),
    )
    .catch(() => null)

  if (response === null || !response.ok) {
    return {}
  }

  const body = Schema.decodeUnknownSync(ProjectionBodySchema)(await response.json())

  return body.value?.pulls ?? {}
}

async function syncRepo(
  env: EngineEnv,
  sink: PullSignalSink,
  repo: LinkedRepo,
  known: PullInboxState['pulls'],
): Promise<{ report: RepoSyncReport; upserted: number }> {
  try {
    const result = await listOpenPulls(env, repo)

    const changed = result.pulls.filter(
      (pull) => !alreadyRecorded(known[pullKey(pull.fullName, pull.number)], pull),
    )

    const signals = changed.map(toUpsertSignal)

    for (let index = 0; index < signals.length; index += SIGNAL_BATCH) {
      await sink.signal(signals.slice(index, index + SIGNAL_BATCH))
    }

    return {
      report: {
        fullName: repo.fullName,
        status: 'ok',
        open: result.totalCount,
        synced: result.pulls.length,
        checksHidden: result.checksHidden,
        message: null,
      },
      upserted: signals.length,
    }
  } catch (cause) {
    return {
      report: {
        fullName: repo.fullName,
        open: 0,
        synced: 0,
        checksHidden: false,
        ...classifySyncError(cause),
      },
      upserted: 0,
    }
  }
}

async function installationAccess(
  env: EngineEnv,
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
  env: EngineEnv,
  sink: PullSignalSink,
  runId: string,
  folderId: string,
  repos: readonly LinkedRepo[],
): Promise<FolderSyncReport> {
  const known = await knownPulls(sink, runId)
  const synced = await Promise.all(repos.map((repo) => syncRepo(env, sink, repo, known)))
  const reports = synced.map((entry) => entry.report)
  const installationIds = [...new Set(repos.map((repo) => repo.installationId))]

  const installations = (
    await Promise.all(installationIds.map((id) => installationAccess(env, id)))
  ).filter((entry): entry is InstallationAccessReport => entry !== null)

  return {
    folderId,
    upserted: synced.reduce((sum, entry) => sum + entry.upserted, 0),
    repos: reports,
    installations,
  }
}

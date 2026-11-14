import type { ShuttleEnv } from '../env'
import type { LinkedRepo } from '../workspace/scope'
import {
  getInstallationToken,
  githubFetch,
  githubGraphql,
  githubUserToken,
  GithubGraphqlError,
} from './client'

export type PullReviewVerdict = 'approve' | 'request_changes' | 'comment'

export interface PullSummary {
  readonly installationId: number
  readonly fullName: string
  readonly number: number
  readonly title: string
  readonly body: string
  readonly url: string
  readonly state: 'open' | 'closed'
  readonly draft: boolean
  readonly authorLogin: string
  readonly authorAvatarUrl: string
  readonly headRef: string
  readonly headSha: string
  readonly baseRef: string
  readonly baseSha: string
  readonly additions: number
  readonly deletions: number
  readonly reviewDecision: 'approved' | 'changes_requested' | 'review_required' | 'none'
  readonly checkRollup: 'passing' | 'failing' | 'pending' | 'neutral'
  readonly updatedAt: number
  readonly isFork: boolean
  readonly stack: PullStackMembership | null
}

export interface CreatePullRequestInput {
  readonly repo: LinkedRepo
  readonly title: string
  readonly body: string
  readonly head: string
  readonly base: string
  readonly draft?: boolean
}

export interface PullReviewComment {
  readonly path: string
  readonly line: number
  readonly side: 'LEFT' | 'RIGHT'
  readonly body: string
}

export interface SubmitReviewInput {
  readonly repo: LinkedRepo
  readonly number: number
  readonly commitId: string
  readonly body: string
  readonly verdict: PullReviewVerdict
  readonly comments: readonly PullReviewComment[]
}

export interface PullFile {
  readonly path: string
  readonly status: string
  readonly additions: number
  readonly deletions: number
  readonly patch?: string
}

export interface ReviewThread {
  readonly id: string
  readonly path: string
  readonly line: number | null
  readonly isResolved: boolean
  readonly comments: readonly { readonly body: string; readonly authorLogin: string }[]
}

function mapReviewDecision(value: string | null | undefined): PullSummary['reviewDecision'] {
  switch (value) {
    case 'APPROVED':
      return 'approved'
    case 'CHANGES_REQUESTED':
      return 'changes_requested'
    case 'REVIEW_REQUIRED':
      return 'review_required'
    case null:
    case undefined:
    case 'NONE':
      return 'none'
    default:
      return 'none'
  }
}

function mapCheckRollup(state: string | null | undefined): PullSummary['checkRollup'] {
  switch (state) {
    case 'SUCCESS':
      return 'passing'
    case 'FAILURE':
    case 'ERROR':
      return 'failing'
    case 'PENDING':
    case 'EXPECTED':
      return 'pending'
    default:
      return 'neutral'
  }
}

export interface UpdatePullRequestInput {
  readonly repo: LinkedRepo
  readonly number: number
  readonly title?: string
  readonly body?: string
  readonly draft?: boolean
  readonly base?: string
}

export interface PullStackMembership {
  readonly number: number
  readonly position: number
  readonly size: number
}

export interface GithubStack {
  readonly number: number
  readonly url: string
  readonly pullNumbers: readonly number[]
}

const STACKS_API_VERSION = '2026-03-10'

export async function createPullRequest(
  env: ShuttleEnv,
  input: CreatePullRequestInput,
): Promise<PullSummary> {
  const payload = JSON.stringify({
    title: input.title,
    body: input.body,
    head: input.head,
    base: input.base,
    draft: input.draft ?? true,
  })

  const postPull = (token: string) =>
    githubFetch(env, `/repos/${input.repo.owner}/${input.repo.name}/pulls`, {
      method: 'POST',
      token,
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    })

  const appToken = await getInstallationToken(env, input.repo.installationId)
  let token = appToken
  let response = await postPull(token)

  if (response.status === 403) {
    const user = githubUserToken(env)

    if (user) {
      token = user
      response = await postPull(user)
    }
  }

  if (response.status === 422) {
    const existing = await findOpenPullByHead(env, input.repo, input.head, token)

    if (existing) {
      return existing
    }
  }

  if (!response.ok) {
    const detail =
      response.status === 403
        ? ' — grant the GitHub App Pull requests (read/write) permission and approve the install update'
        : ''

    throw new Error(`Failed to create pull request: ${response.status}${detail}`)
  }

  return pullSummaryFromRest(input.repo, (await response.json()) as GithubPullRestBody)
}

type GithubPullRestBody = {
  number: number
  title: string
  body?: string
  html_url: string
  state: string
  draft?: boolean
  user?: { login?: string; avatar_url?: string }
  head: { ref: string; sha: string; repo?: { fork?: boolean } | null }
  base: { ref: string; sha: string }
  additions?: number
  deletions?: number
  updated_at: string
  stack?: { number?: number; position?: number; size?: number } | null
}

function pullSummaryFromRest(
  repo: Pick<LinkedRepo, 'installationId' | 'fullName'>,
  body: GithubPullRestBody,
): PullSummary {
  return {
    installationId: repo.installationId,
    fullName: repo.fullName,
    number: body.number,
    title: body.title,
    body: body.body ?? '',
    url: body.html_url,
    state: body.state === 'closed' ? 'closed' : 'open',
    draft: Boolean(body.draft),
    authorLogin: body.user?.login ?? 'unknown',
    authorAvatarUrl: body.user?.avatar_url ?? '',
    headRef: body.head.ref,
    headSha: body.head.sha,
    baseRef: body.base.ref,
    baseSha: body.base.sha,
    additions: body.additions ?? 0,
    deletions: body.deletions ?? 0,
    reviewDecision: 'none',
    checkRollup: 'pending',
    updatedAt: Date.parse(body.updated_at),
    isFork: Boolean(body.head.repo?.fork),
    stack: stackFromRest(body),
  }
}

export async function updatePullRequest(
  env: ShuttleEnv,
  input: UpdatePullRequestInput,
): Promise<PullSummary> {
  const token = await getInstallationToken(env, input.repo.installationId)
  const body: Record<string, unknown> = {}

  if (input.title !== undefined) {
    body.title = input.title
  }

  if (input.body !== undefined) {
    body.body = input.body
  }

  if (input.base !== undefined) {
    body.base = input.base
  }

  // Draft toggling uses a separate endpoint on some API versions; skip when unchanged.
  if (input.draft !== undefined) {
    body.draft = input.draft
  }

  const response = await githubFetch(
    env,
    `/repos/${input.repo.owner}/${input.repo.name}/pulls/${input.number}`,
    {
      method: 'PATCH',
      token,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  )

  if (!response.ok) {
    throw new Error(`Failed to update pull request #${input.number}: ${response.status}`)
  }

  return pullSummaryFromRest(input.repo, (await response.json()) as GithubPullRestBody)
}

export async function createStack(
  env: ShuttleEnv,
  repo: LinkedRepo,
  pullNumbers: readonly number[],
): Promise<GithubStack> {
  const token = await getInstallationToken(env, repo.installationId)

  const response = await githubFetch(env, `/repos/${repo.owner}/${repo.name}/stacks`, {
    method: 'POST',
    token,
    apiVersion: STACKS_API_VERSION,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pull_requests: [...pullNumbers] }),
  })

  if (!response.ok) {
    throw new Error(`Failed to create stack: ${response.status}`)
  }

  return parseStackResponse(repo, (await response.json()) as StackRestBody)
}

export async function addToStack(
  env: ShuttleEnv,
  repo: LinkedRepo,
  stackNumber: number,
  pullNumbers: readonly number[],
): Promise<GithubStack> {
  const token = await getInstallationToken(env, repo.installationId)

  const response = await githubFetch(
    env,
    `/repos/${repo.owner}/${repo.name}/stacks/${stackNumber}/add`,
    {
      method: 'POST',
      token,
      apiVersion: STACKS_API_VERSION,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pull_requests: [...pullNumbers] }),
    },
  )

  if (!response.ok) {
    throw new Error(`Failed to add to stack #${stackNumber}: ${response.status}`)
  }

  return parseStackResponse(repo, (await response.json()) as StackRestBody)
}

type StackRestBody = {
  number: number
  url?: string
  html_url?: string
  pull_requests?: { number: number }[]
}

function parseStackResponse(repo: LinkedRepo, body: StackRestBody): GithubStack {
  return {
    number: body.number,
    url:
      body.url ?? body.html_url ?? `https://github.com/${repo.fullName}/pulls?stack=${body.number}`,
    pullNumbers: (body.pull_requests ?? []).map((pull) => pull.number),
  }
}

function stackFromRest(body: {
  stack?: { number?: number; position?: number; size?: number } | null
}): PullStackMembership | null {
  const stack = body.stack

  if (
    !stack ||
    typeof stack.number !== 'number' ||
    typeof stack.position !== 'number' ||
    typeof stack.size !== 'number'
  ) {
    return null
  }

  return { number: stack.number, position: stack.position, size: stack.size }
}

/** When create returns 422 because the head branch already has a PR, reuse it. */
async function findOpenPullByHead(
  env: ShuttleEnv,
  repo: LinkedRepo,
  head: string,
  token: string,
): Promise<PullSummary | null> {
  const headParam = encodeURIComponent(`${repo.owner}:${head}`)

  const response = await githubFetch(
    env,
    `/repos/${repo.owner}/${repo.name}/pulls?state=open&head=${headParam}`,
    { token },
  )

  if (!response.ok) {
    return null
  }

  const body = (await response.json()) as GithubPullRestBody[]
  const match = body[0]

  return match ? pullSummaryFromRest(repo, match) : null
}

export async function getPullRequest(
  env: ShuttleEnv,
  repo: LinkedRepo,
  number: number,
): Promise<PullSummary> {
  const token = await getInstallationToken(env, repo.installationId)

  const response = await githubFetch(env, `/repos/${repo.owner}/${repo.name}/pulls/${number}`, {
    token,
  })

  if (!response.ok) {
    throw new Error(`Failed to load pull request #${number}: ${response.status}`)
  }

  const body = (await response.json()) as {
    number: number
    title: string
    body?: string
    html_url: string
    state: string
    draft?: boolean
    user?: { login?: string; avatar_url?: string }
    head: { ref: string; sha: string; repo?: { fork?: boolean } | null }
    base: { ref: string; sha: string }
    additions?: number
    deletions?: number
    updated_at: string
  }

  return {
    installationId: repo.installationId,
    fullName: repo.fullName,
    number: body.number,
    title: body.title,
    body: body.body ?? '',
    url: body.html_url,
    state: body.state === 'closed' ? 'closed' : 'open',
    draft: Boolean(body.draft),
    authorLogin: body.user?.login ?? 'unknown',
    authorAvatarUrl: body.user?.avatar_url ?? '',
    headRef: body.head.ref,
    headSha: body.head.sha,
    baseRef: body.base.ref,
    baseSha: body.base.sha,
    additions: body.additions ?? 0,
    deletions: body.deletions ?? 0,
    reviewDecision: 'none',
    checkRollup: 'neutral',
    updatedAt: Date.parse(body.updated_at),
    isFork: Boolean(body.head.repo?.fork),
    stack: stackFromRest(body as GithubPullRestBody),
  }
}

export async function listPullFiles(
  env: ShuttleEnv,
  repo: LinkedRepo,
  number: number,
): Promise<PullFile[]> {
  const token = await getInstallationToken(env, repo.installationId)
  const files: PullFile[] = []
  let page = 1

  while (page <= 10) {
    const response = await githubFetch(
      env,
      `/repos/${repo.owner}/${repo.name}/pulls/${number}/files?per_page=100&page=${page}`,
      { token },
    )

    if (!response.ok) {
      throw new Error(`Failed to list pull files: ${response.status}`)
    }

    const batch = (await response.json()) as {
      filename: string
      status: string
      additions: number
      deletions: number
      patch?: string
    }[]

    for (const file of batch) {
      files.push({
        path: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        patch: file.patch,
      })
    }

    if (batch.length < 100) {
      break
    }

    page += 1
  }

  return files
}

export async function listReviewThreads(
  env: ShuttleEnv,
  repo: LinkedRepo,
  number: number,
): Promise<ReviewThread[]> {
  const data = await githubGraphql<{
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: {
            id: string
            isResolved: boolean
            path: string
            line: number | null
            comments: {
              nodes: { body: string; author: { login: string } | null }[]
            }
          }[]
        }
      }
    }
  }>(
    env,
    `query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              path
              line
              comments(first: 20) {
                nodes { body author { login } }
              }
            }
          }
        }
      }
    }`,
    { owner: repo.owner, name: repo.name, number },
    repo.installationId,
  )

  return data.repository.pullRequest.reviewThreads.nodes.map((thread) => ({
    id: thread.id,
    path: thread.path,
    line: thread.line,
    isResolved: thread.isResolved,
    comments: thread.comments.nodes.map((comment) => ({
      body: comment.body,
      authorLogin: comment.author?.login ?? 'unknown',
    })),
  }))
}

export async function submitPullReview(
  env: ShuttleEnv,
  input: SubmitReviewInput,
): Promise<{ id: number }> {
  const token = await getInstallationToken(env, input.repo.installationId)

  let event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'

  switch (input.verdict) {
    case 'approve':
      event = 'APPROVE'
      break
    case 'request_changes':
      event = 'REQUEST_CHANGES'
      break
    case 'comment':
      event = 'COMMENT'
      break

    default: {
      const exhaustive: never = input.verdict
      throw new Error(`Unknown verdict: ${exhaustive}`)
    }
  }

  const response = await githubFetch(
    env,
    `/repos/${input.repo.owner}/${input.repo.name}/pulls/${input.number}/reviews`,
    {
      method: 'POST',
      token,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commit_id: input.commitId,
        body: input.body,
        event,
        comments: input.comments.map((comment) => ({
          path: comment.path,
          line: comment.line,
          side: comment.side,
          body: comment.body,
        })),
      }),
    },
  )

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 500)

    throw new Error(`GitHub refused the review (${response.status})${detail ? `: ${detail}` : ''}`)
  }

  const body = (await response.json()) as { id: number }
  return { id: body.id }
}

const OPEN_PULLS_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(
      states: OPEN
      first: 50
      after: $after
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        title
        body
        url
        state
        isDraft
        updatedAt
        additions
        deletions
        author { login avatarUrl }
        headRefName
        headRefOid
        baseRefName
        baseRefOid
        reviewDecision
        stack { number size }
        stackEntry { position }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup { state }
            }
          }
        }
        headRepository { isFork }
      }
    }
  }
}`

interface OpenPullNode {
  number?: number
  title?: string
  body?: string
  url?: string
  state?: string
  isDraft?: boolean
  updatedAt?: string
  additions?: number
  deletions?: number
  author?: { login?: string; avatarUrl?: string } | null
  headRefName?: string
  headRefOid?: string
  baseRefName?: string
  baseRefOid?: string
  reviewDecision?: string | null
  stack?: { number?: number; size?: number } | null
  stackEntry?: { position?: number } | null
  commits?: {
    nodes: { commit: { statusCheckRollup: { state: string } | null } | null }[]
  } | null
  headRepository?: { isFork?: boolean } | null
}

interface OpenPullsPage {
  repository: {
    pullRequests: {
      totalCount: number
      pageInfo: { hasNextPage: boolean; endCursor: string | null }
      nodes: (OpenPullNode | null)[]
    } | null
  } | null
}

/** Inbox rows only need a preview; full descriptions live on GitHub. */
const BODY_PREVIEW_CHARS = 8_000

export const MAX_SYNCED_PULLS_PER_REPO = 500

export interface OpenPullsResult {
  readonly pulls: readonly PullSummary[]
  readonly totalCount: number
  /** Check rollups were withheld (missing Checks/Commit statuses permission). */
  readonly checksHidden: boolean
}

/**
 * Lists one repo's open PRs, newest activity first. Unlike search, the repository
 * query fails loudly when the installation cannot read the repo's pull requests.
 */
export async function listOpenPulls(
  env: ShuttleEnv,
  repo: Pick<LinkedRepo, 'installationId' | 'owner' | 'name' | 'fullName'>,
  limit = MAX_SYNCED_PULLS_PER_REPO,
): Promise<OpenPullsResult> {
  const pulls: PullSummary[] = []
  let after: string | null = null
  let totalCount = 0
  let checksHidden = false

  while (pulls.length < limit) {
    const { page, partial } = await fetchOpenPullsPage(env, repo, after)
    const connection = page.repository?.pullRequests

    if (!connection) {
      throw new Error(`GitHub returned no pull requests for ${repo.fullName}`)
    }

    checksHidden ||= partial
    totalCount = connection.totalCount

    for (const node of connection.nodes) {
      if (node?.number != null) {
        pulls.push(toPullSummary(repo, node))
      }
    }

    if (!connection.pageInfo.hasNextPage || !connection.pageInfo.endCursor) {
      break
    }

    after = connection.pageInfo.endCursor
  }

  return { pulls: pulls.slice(0, limit), totalCount, checksHidden }
}

/** Without Checks permission GraphQL nulls the rollup and reports FORBIDDEN; the PRs still count. */
async function fetchOpenPullsPage(
  env: ShuttleEnv,
  repo: Pick<LinkedRepo, 'installationId' | 'owner' | 'name'>,
  after: string | null,
): Promise<{ page: OpenPullsPage; partial: boolean }> {
  try {
    const page = await githubGraphql<OpenPullsPage>(
      env,
      OPEN_PULLS_QUERY,
      { owner: repo.owner, name: repo.name, after },
      repo.installationId,
    )

    return { page, partial: false }
  } catch (cause) {
    const data = cause instanceof GithubGraphqlError ? (cause.data as OpenPullsPage | null) : null

    if (data?.repository?.pullRequests) {
      return { page: data, partial: true }
    }

    throw cause
  }
}

function toPullSummary(
  repo: Pick<LinkedRepo, 'installationId' | 'fullName'>,
  node: OpenPullNode,
): PullSummary {
  const rollup = node.commits?.nodes[0]?.commit?.statusCheckRollup?.state ?? null
  const body = node.body ?? ''

  return {
    installationId: repo.installationId,
    fullName: repo.fullName,
    number: node.number ?? 0,
    title: node.title ?? '',
    body: body.length > BODY_PREVIEW_CHARS ? `${body.slice(0, BODY_PREVIEW_CHARS)}…` : body,
    url: node.url ?? '',
    state: node.state === 'CLOSED' || node.state === 'MERGED' ? 'closed' : 'open',
    draft: Boolean(node.isDraft),
    authorLogin: node.author?.login ?? 'unknown',
    authorAvatarUrl: node.author?.avatarUrl ?? '',
    headRef: node.headRefName ?? '',
    headSha: node.headRefOid ?? '',
    baseRef: node.baseRefName ?? '',
    baseSha: node.baseRefOid ?? '',
    additions: node.additions ?? 0,
    deletions: node.deletions ?? 0,
    reviewDecision: mapReviewDecision(node.reviewDecision),
    checkRollup: mapCheckRollup(rollup),
    updatedAt: node.updatedAt ? Date.parse(node.updatedAt) : Date.now(),
    isFork: Boolean(node.headRepository?.isFork),
    stack:
      node.stack?.number != null && node.stackEntry?.position != null && node.stack.size != null
        ? {
            number: node.stack.number,
            position: node.stackEntry.position,
            size: node.stack.size,
          }
        : null,
  }
}

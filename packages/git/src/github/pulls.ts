import { z } from 'zod'

import type { LinkedRepo } from '@shuttle/core/workspace'

import type { GitEnv } from '../env'
import {
  getInstallationToken,
  githubFetch,
  githubGraphql,
  githubGraphqlWithToken,
  githubUserToken,
  GithubGraphqlError,
} from './client'
import { commentFromWebhook, ReviewCommentSchema, type WebhookComment } from './webhooks'

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
    case null:
    case undefined:
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
  env: GitEnv,
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

    if (user !== null) {
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

  return pullSummaryFromRest(input.repo, GithubPullRestBodySchema.parse(await response.json()))
}

const GithubPullRestBodySchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullish(),
  html_url: z.string(),
  state: z.string(),
  draft: z.boolean().optional(),
  user: z.object({ login: z.string().optional(), avatar_url: z.string().optional() }).nullish(),
  head: z.object({
    ref: z.string(),
    sha: z.string(),
    repo: z.object({ fork: z.boolean().optional() }).nullish(),
  }),
  base: z.object({ ref: z.string(), sha: z.string() }),
  additions: z.number().optional(),
  deletions: z.number().optional(),
  updated_at: z.string(),
  stack: z
    .object({
      number: z.number().optional(),
      position: z.number().optional(),
      size: z.number().optional(),
    })
    .nullish(),
})

type GithubPullRestBody = z.infer<typeof GithubPullRestBodySchema>

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
    // Nothing has been heard about checks yet, and a repository may have none.
    checkRollup: 'neutral',
    updatedAt: Date.parse(body.updated_at),
    isFork: Boolean(body.head.repo?.fork),
    stack: stackFromRest(body),
  }
}

export async function updatePullRequest(
  env: GitEnv,
  input: UpdatePullRequestInput,
): Promise<PullSummary> {
  const token = await getInstallationToken(env, input.repo.installationId)
  // Fields left undefined are dropped when the body is serialized. GitHub may handle draft
  // toggling on a separate endpoint on some API versions; it is sent only when it is given.
  const body = { title: input.title, body: input.body, base: input.base, draft: input.draft }

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

  return pullSummaryFromRest(input.repo, GithubPullRestBodySchema.parse(await response.json()))
}

export async function createStack(
  env: GitEnv,
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

  return parseStackResponse(repo, StackRestBodySchema.parse(await response.json()))
}

export async function addToStack(
  env: GitEnv,
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

  return parseStackResponse(repo, StackRestBodySchema.parse(await response.json()))
}

const StackRestBodySchema = z.object({
  number: z.number(),
  url: z.string().optional(),
  html_url: z.string().optional(),
  pull_requests: z.array(z.object({ number: z.number() })).optional(),
})

type StackRestBody = z.infer<typeof StackRestBodySchema>

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

  if (!stack) {
    return null
  }

  const { number, position, size } = stack

  if (number === undefined || position === undefined || size === undefined) {
    return null
  }

  return { number, position, size }
}

/** When create returns 422 because the head branch already has a PR, reuse it. */
async function findOpenPullByHead(
  env: GitEnv,
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

  const body = z.array(GithubPullRestBodySchema).parse(await response.json())
  const match = body[0]

  return match ? pullSummaryFromRest(repo, match) : null
}

export async function getPullRequest(
  env: GitEnv,
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

  return {
    ...pullSummaryFromRest(repo, GithubPullRestBodySchema.parse(await response.json())),
    checkRollup: 'neutral',
  }
}

const PullFilesSchema = z.array(
  z.object({
    filename: z.string(),
    status: z.string(),
    additions: z.number(),
    deletions: z.number(),
    patch: z.string().optional(),
  }),
)

export async function listPullFiles(
  env: GitEnv,
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

    const batch = PullFilesSchema.parse(await response.json())

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

const ReviewThreadsSchema = z.object({
  repository: z.object({
    pullRequest: z.object({
      reviewThreads: z.object({
        nodes: z.array(
          z.object({
            id: z.string(),
            isResolved: z.boolean(),
            path: z.string(),
            line: z.number().nullable(),
            comments: z.object({
              nodes: z.array(
                z.object({
                  body: z.string(),
                  author: z.object({ login: z.string() }).nullable(),
                }),
              ),
            }),
          }),
        ),
      }),
    }),
  }),
})

export async function listReviewThreads(
  env: GitEnv,
  repo: LinkedRepo,
  number: number,
): Promise<ReviewThread[]> {
  const data = await githubGraphql(
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
    ReviewThreadsSchema,
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

/** One review thread on GitHub with everything about its comments. */
export interface PullThreadSnapshot {
  readonly rootId: number
  readonly resolved: boolean
  readonly comments: readonly {
    readonly commentId: number
    readonly rootId: number
    readonly path: string
    readonly line: number | null
    readonly startLine?: number
    readonly side: 'LEFT' | 'RIGHT'
    readonly outdated: boolean
    readonly body: string
    readonly author: { readonly login: string; readonly avatarUrl: string }
    readonly createdAt: number
    readonly updatedAt: number
    readonly url: string
  }[]
}

const PageInfoSchema = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() })

const ThreadNodeSchema = z.object({
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  path: z.string(),
  line: z.number().nullable(),
  originalLine: z.number().nullable(),
  startLine: z.number().nullable(),
  originalStartLine: z.number().nullable(),
  diffSide: z.enum(['LEFT', 'RIGHT']),
  comments: z.object({
    nodes: z.array(
      z.object({
        fullDatabaseId: z.string(),
        body: z.string(),
        url: z.string(),
        createdAt: z.string(),
        updatedAt: z.string(),
        author: z.object({ login: z.string(), avatarUrl: z.string() }).nullable(),
      }),
    ),
  }),
})

type ThreadNode = z.infer<typeof ThreadNodeSchema>

const ThreadsPageSchema = z.object({
  repository: z.object({
    pullRequest: z
      .object({
        reviewThreads: z.object({ pageInfo: PageInfoSchema, nodes: z.array(ThreadNodeSchema) }),
      })
      .nullable(),
  }),
})

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          isOutdated
          path
          line
          originalLine
          startLine
          originalStartLine
          diffSide
          comments(first: 100) {
            nodes {
              fullDatabaseId
              body
              url
              createdAt
              updatedAt
              author { login avatarUrl }
            }
          }
        }
      }
    }
  }
}`

/** How many pages of threads are read: a pull request with more than this is cut short. */
const THREAD_PAGES = 10

/** A thread as the mirror keeps it. Null for a thread GitHub reports with no comments. */
export function threadSnapshot(node: ThreadNode): PullThreadSnapshot | null {
  const rootId = Number(node.comments.nodes[0]?.fullDatabaseId)

  if (!Number.isSafeInteger(rootId) || rootId <= 0) {
    return null
  }

  const startLine = node.startLine ?? node.originalStartLine

  return {
    rootId,
    resolved: node.isResolved,
    comments: node.comments.nodes.map((comment) => ({
      commentId: Number(comment.fullDatabaseId),
      rootId,
      path: node.path,
      line: node.line ?? node.originalLine,
      startLine: startLine ?? undefined,
      side: node.diffSide === 'LEFT' ? 'LEFT' : 'RIGHT',
      outdated: node.isOutdated,
      body: comment.body,
      author: {
        login: comment.author?.login ?? 'unknown',
        avatarUrl: comment.author?.avatarUrl ?? '',
      },
      createdAt: Date.parse(comment.createdAt),
      updatedAt: Date.parse(comment.updatedAt),
      url: comment.url,
    })),
  }
}

/** Every review thread on a pull request, as GitHub has them now. */
export async function listPullThreads(
  env: GitEnv,
  repo: LinkedRepo,
  number: number,
): Promise<PullThreadSnapshot[]> {
  const threads: PullThreadSnapshot[] = []
  let after: string | null = null

  for (let page = 0; page < THREAD_PAGES; page += 1) {
    const data: z.infer<typeof ThreadsPageSchema> = await githubGraphql(
      env,
      THREADS_QUERY,
      { owner: repo.owner, name: repo.name, number, after },
      repo.installationId,
      ThreadsPageSchema,
    )

    const connection = data.repository.pullRequest?.reviewThreads

    if (!connection) {
      break
    }

    threads.push(...connection.nodes.flatMap((node) => threadSnapshot(node) ?? []))

    if (!connection.pageInfo.hasNextPage) {
      break
    }

    after = connection.pageInfo.endCursor
  }

  return threads
}

/** A comment someone is posting in their own name, with the token that acts as them. */
interface AsPerson {
  readonly repo: LinkedRepo
  readonly number: number
  readonly userToken: string
}

async function postComment(
  env: GitEnv,
  path: string,
  userToken: string,
  payload: Readonly<Record<string, string | number | undefined>>,
): Promise<WebhookComment> {
  const response = await githubFetch(env, path, {
    method: 'POST',
    token: userToken,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300)

    throw new Error(
      `GitHub refused the comment (${response.status})${detail.length > 0 ? `: ${detail}` : ''}`,
    )
  }

  return commentFromWebhook(ReviewCommentSchema.parse(await response.json()))
}

/** Replies to a review thread as the person. `rootId` is the thread's first comment. */
export function replyToThread(
  env: GitEnv,
  input: AsPerson & { readonly rootId: number; readonly body: string },
): Promise<WebhookComment> {
  return postComment(
    env,
    `/repos/${input.repo.owner}/${input.repo.name}/pulls/${input.number}/comments/${input.rootId}/replies`,
    input.userToken,
    { body: input.body },
  )
}

/** Starts a review thread on a line of the pull request's diff as the person. */
export function commentOnLine(
  env: GitEnv,
  input: AsPerson & {
    readonly commitId: string
    readonly path: string
    readonly line: number
    readonly side: 'LEFT' | 'RIGHT'
    /** For a comment about several lines: where they start. `line` is where they end. */
    readonly start?: { readonly line: number; readonly side: 'LEFT' | 'RIGHT' }
    readonly body: string
  },
): Promise<WebhookComment> {
  const payload = {
    body: input.body,
    commit_id: input.commitId,
    path: input.path,
    line: input.line,
    side: input.side,
    start_line: input.start?.line,
    start_side: input.start?.side,
  }

  return postComment(
    env,
    `/repos/${input.repo.owner}/${input.repo.name}/pulls/${input.number}/comments`,
    input.userToken,
    payload,
  )
}

const ThreadIdsPageSchema = z.object({
  repository: z.object({
    pullRequest: z
      .object({
        reviewThreads: z.object({
          pageInfo: PageInfoSchema,
          nodes: z.array(
            z.object({
              id: z.string(),
              comments: z.object({ nodes: z.array(z.object({ fullDatabaseId: z.string() })) }),
            }),
          ),
        }),
      })
      .nullable(),
  }),
})

const THREAD_IDS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id comments(first: 1) { nodes { fullDatabaseId } } }
      }
    }
  }
}`

/**
 * Resolves or reopens a review thread as the person. GitHub only does this by the thread's own
 * id, which nothing else carries, so it is looked up from the thread's first comment.
 */
export async function setThreadResolved(
  input: AsPerson & { readonly rootId: number; readonly resolved: boolean },
): Promise<void> {
  let threadId: string | undefined
  let after: string | null = null

  for (let page = 0; page < THREAD_PAGES && threadId === undefined; page += 1) {
    const data: z.infer<typeof ThreadIdsPageSchema> = await githubGraphqlWithToken(
      THREAD_IDS_QUERY,
      { owner: input.repo.owner, name: input.repo.name, number: input.number, after },
      input.userToken,
      ThreadIdsPageSchema,
    )

    const connection = data.repository.pullRequest?.reviewThreads

    threadId = connection?.nodes.find(
      (node) => Number(node.comments.nodes[0]?.fullDatabaseId) === input.rootId,
    )?.id

    if (connection?.pageInfo.hasNextPage !== true) {
      break
    }

    after = connection.pageInfo.endCursor
  }

  if (threadId === undefined) {
    throw new Error('That thread is no longer on the pull request.')
  }

  const mutation = input.resolved ? 'resolveReviewThread' : 'unresolveReviewThread'

  await githubGraphqlWithToken(
    `mutation($threadId: ID!) { ${mutation}(input: { threadId: $threadId }) { thread { id } } }`,
    { threadId },
    input.userToken,
    z.unknown(),
  )
}

export async function submitPullReview(
  env: GitEnv,
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
      throw new Error('Unknown verdict', { cause: exhaustive })
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

    throw new Error(
      `GitHub refused the review (${response.status})${detail.length > 0 ? `: ${detail}` : ''}`,
    )
  }

  const body = z.object({ id: z.number() }).parse(await response.json())
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

const OpenPullNodeSchema = z.object({
  number: z.number().nullish(),
  title: z.string().nullish(),
  body: z.string().nullish(),
  url: z.string().nullish(),
  state: z.string().nullish(),
  isDraft: z.boolean().nullish(),
  updatedAt: z.string().nullish(),
  additions: z.number().nullish(),
  deletions: z.number().nullish(),
  author: z.object({ login: z.string().nullish(), avatarUrl: z.string().nullish() }).nullish(),
  headRefName: z.string().nullish(),
  headRefOid: z.string().nullish(),
  baseRefName: z.string().nullish(),
  baseRefOid: z.string().nullish(),
  reviewDecision: z.string().nullish(),
  stack: z.object({ number: z.number().nullish(), size: z.number().nullish() }).nullish(),
  stackEntry: z.object({ position: z.number().nullish() }).nullish(),
  commits: z
    .object({
      nodes: z.array(
        z.object({
          commit: z
            .object({ statusCheckRollup: z.object({ state: z.string() }).nullish() })
            .nullish(),
        }),
      ),
    })
    .nullish(),
  headRepository: z.object({ isFork: z.boolean().nullish() }).nullish(),
})

type OpenPullNode = z.infer<typeof OpenPullNodeSchema>

const OpenPullsPageSchema = z.object({
  repository: z
    .object({
      pullRequests: z
        .object({
          totalCount: z.number(),
          pageInfo: PageInfoSchema,
          nodes: z.array(OpenPullNodeSchema.nullable()),
        })
        .nullable(),
    })
    .nullable(),
})

type OpenPullsPage = z.infer<typeof OpenPullsPageSchema>

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
  env: GitEnv,
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

    const { endCursor } = connection.pageInfo

    if (!connection.pageInfo.hasNextPage || endCursor === null || endCursor === '') {
      break
    }

    after = endCursor
  }

  return { pulls: pulls.slice(0, limit), totalCount, checksHidden }
}

/** Without Checks permission GraphQL nulls the rollup and reports FORBIDDEN; the PRs still count. */
async function fetchOpenPullsPage(
  env: GitEnv,
  repo: Pick<LinkedRepo, 'installationId' | 'owner' | 'name'>,
  after: string | null,
): Promise<{ page: OpenPullsPage; partial: boolean }> {
  try {
    const page = await githubGraphql(
      env,
      OPEN_PULLS_QUERY,
      { owner: repo.owner, name: repo.name, after },
      repo.installationId,
      OpenPullsPageSchema,
    )

    return { page, partial: false }
  } catch (cause) {
    if (cause instanceof GithubGraphqlError) {
      const partial = OpenPullsPageSchema.safeParse(cause.data)

      if (partial.success && partial.data.repository?.pullRequests) {
        return { page: partial.data, partial: true }
      }
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
    updatedAt:
      node.updatedAt !== undefined && node.updatedAt !== null && node.updatedAt !== ''
        ? Date.parse(node.updatedAt)
        : Date.now(),
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

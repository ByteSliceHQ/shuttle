import { z } from 'zod'

import type { LinkedRepo } from '@shuttle/core/workspace'

import type { GitEnv } from '../env'
import { getInstallationToken, githubFetch, ShaBodySchema } from './client'
import { commitIdentityOf, type CommitIdentity } from './commit-identity'

export type ChangesetFileStatus = 'added' | 'modified' | 'deleted'

export interface ChangesetFile {
  readonly path: string
  readonly status: ChangesetFileStatus
  /** Null for deleted files. */
  readonly content: string | null
  /** Git mode; defaults to 100644 for blobs. */
  readonly mode?: string
}

export interface CommitChangesetInput {
  readonly repo: LinkedRepo
  readonly baseSha: string
  readonly branch: string
  readonly files: readonly ChangesetFile[]
  readonly message: string
  /** Shuttle user to credit the commit to, through their linked GitHub account. */
  readonly authorUserId?: string | null
}

export interface CommitChangesetResult {
  readonly commitSha: string
  readonly treeSha: string
  readonly branch: string
}

interface TreeEntry {
  readonly path: string
  readonly mode: string
  readonly type: 'blob' | 'tree' | 'commit'
  readonly sha?: string
  readonly content?: string
}

async function createBlob(
  env: GitEnv,
  repo: LinkedRepo,
  token: string,
  content: string,
): Promise<string> {
  const response = await githubFetch(env, `/repos/${repo.owner}/${repo.name}/git/blobs`, {
    method: 'POST',
    token,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, encoding: 'utf-8' }),
  })

  if (!response.ok) {
    throw new Error(`Failed to create blob: ${response.status}`)
  }

  const body = ShaBodySchema.parse(await response.json())

  if (body.sha === undefined || body.sha === '') {
    throw new Error('Blob response missing sha')
  }

  return body.sha
}

async function createCommit(
  env: GitEnv,
  repo: LinkedRepo,
  token: string,
  message: string,
  treeSha: string,
  parentSha: string,
  author: CommitIdentity | null,
): Promise<string> {
  // Without an author GitHub credits the commit to the App the token belongs to.
  const credit = author === null ? {} : { author, committer: author }

  const response = await githubFetch(env, `/repos/${repo.owner}/${repo.name}/git/commits`, {
    method: 'POST',
    token,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      tree: treeSha,
      parents: [parentSha],
      ...credit,
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to create commit: ${response.status}`)
  }

  const body = ShaBodySchema.parse(await response.json())

  if (body.sha === undefined || body.sha === '') {
    throw new Error('Commit response missing sha')
  }

  return body.sha
}

const CommitBodySchema = z.object({ tree: z.object({ sha: z.string().optional() }).optional() })

async function getCommitTreeSha(
  env: GitEnv,
  repo: LinkedRepo,
  token: string,
  commitSha: string,
): Promise<string> {
  const response = await githubFetch(
    env,
    `/repos/${repo.owner}/${repo.name}/git/commits/${commitSha}`,
    { token },
  )

  if (!response.ok) {
    throw new Error(`Failed to load commit ${commitSha}: ${response.status}`)
  }

  const body = CommitBodySchema.parse(await response.json())

  if (body.tree?.sha === undefined || body.tree.sha === '') {
    throw new Error(`Commit ${commitSha} missing tree sha`)
  }

  return body.tree.sha
}

async function upsertBranchRef(
  env: GitEnv,
  repo: LinkedRepo,
  token: string,
  branch: string,
  commitSha: string,
): Promise<void> {
  const ref = `refs/heads/${branch}`

  const getResponse = await githubFetch(
    env,
    `/repos/${repo.owner}/${repo.name}/git/ref/heads/${branch}`,
    {
      token,
    },
  )

  if (getResponse.status === 404) {
    const createResponse = await githubFetch(env, `/repos/${repo.owner}/${repo.name}/git/refs`, {
      method: 'POST',
      token,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref, sha: commitSha }),
    })

    if (!createResponse.ok) {
      throw new Error(`Failed to create branch ${branch}: ${createResponse.status}`)
    }

    return
  }

  if (!getResponse.ok) {
    throw new Error(`Failed to load branch ${branch}: ${getResponse.status}`)
  }

  // Session-owned shuttle/* branches are rewritten on each publish attempt.
  const updateResponse = await githubFetch(
    env,
    `/repos/${repo.owner}/${repo.name}/git/refs/heads/${branch}`,
    {
      method: 'PATCH',
      token,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha: commitSha, force: true }),
    },
  )

  if (!updateResponse.ok) {
    throw new Error(`Failed to update branch ${branch}: ${updateResponse.status}`)
  }
}

/**
 * Commit sandbox changes onto a branch via the Git Data API.
 * Installation tokens never enter the sandbox — the worker builds the commit.
 */
export async function commitChangeset(
  env: GitEnv,
  input: CommitChangesetInput,
): Promise<CommitChangesetResult> {
  if (input.files.length === 0) {
    throw new Error('Cannot commit an empty changeset')
  }

  const token = await getInstallationToken(env, input.repo.installationId)
  const baseTreeSha = await getCommitTreeSha(env, input.repo, token, input.baseSha)
  const entries: TreeEntry[] = []

  for (const file of input.files) {
    if (file.status === 'deleted') {
      entries.push({
        path: file.path,
        mode: file.mode ?? '100644',
        type: 'blob',
        sha: undefined,
      })

      continue
    }

    if (file.content == null) {
      throw new Error(`Changeset file ${file.path} is missing content`)
    }

    const blobSha = await createBlob(env, input.repo, token, file.content)

    entries.push({
      path: file.path,
      mode: file.mode ?? '100644',
      type: 'blob',
      sha: blobSha,
    })
  }

  // GitHub treats `sha: null` as delete when updating a tree.
  const treePayload = entries.map((entry) =>
    entry.sha === undefined
      ? { path: entry.path, mode: entry.mode, type: entry.type, sha: null }
      : { path: entry.path, mode: entry.mode, type: entry.type, sha: entry.sha },
  )

  const response = await githubFetch(
    env,
    `/repos/${input.repo.owner}/${input.repo.name}/git/trees`,
    {
      method: 'POST',
      token,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_tree: baseTreeSha, tree: treePayload }),
    },
  )

  if (!response.ok) {
    throw new Error(`Failed to create tree: ${response.status}`)
  }

  const treeBody = ShaBodySchema.parse(await response.json())

  if (treeBody.sha === undefined || treeBody.sha === '') {
    throw new Error('Tree response missing sha')
  }

  const treeSha = treeBody.sha

  const author =
    input.authorUserId === undefined || input.authorUserId === null || input.authorUserId === ''
      ? null
      : await commitIdentityOf(env, input.authorUserId, token)

  const commitSha = await createCommit(
    env,
    input.repo,
    token,
    input.message,
    treeSha,
    input.baseSha,
    author,
  )

  await upsertBranchRef(env, input.repo, token, input.branch, commitSha)

  return { commitSha, treeSha, branch: input.branch }
}

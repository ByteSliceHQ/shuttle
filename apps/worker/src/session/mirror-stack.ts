import type { ShuttleEnv } from '../env'
import {
  commitChangeset,
  type CommitChangesetInput,
  type CommitChangesetResult,
} from '../github/git-data'
import {
  addToStack,
  createPullRequest,
  createStack,
  updatePullRequest,
  type CreatePullRequestInput,
  type GithubStack,
  type PullSummary,
  type UpdatePullRequestInput,
} from '../github/pulls'
import type {
  ChangesetResult,
  LayerChangesetInput,
  LinkedSandboxRepo,
  SealLayerResult,
  StackStatus,
  StackStatusLayer,
} from '../sandbox/workspace'
import { planStackPublish } from './plan-stack-publish'
import {
  stackKey,
  type SessionRepoStack,
  type SessionStackLayer,
  type SessionStacks,
} from './stack-state'

export type PublishOutcome = 'opened' | 'updated' | 'unchanged'

export interface MirrorSandbox {
  stackStatus(runId: string, repoName: string, defaultBranch: string): Promise<StackStatus>
  sealLayer(runId: string, repoName: string, message: string): Promise<SealLayerResult>
  layerChangeset(
    runId: string,
    repoName: string,
    input: LayerChangesetInput,
  ): Promise<ChangesetResult>
}

export interface MirrorGitHub {
  commitChangeset(input: CommitChangesetInput): Promise<CommitChangesetResult>
  createPullRequest(input: CreatePullRequestInput): Promise<PullSummary>
  updatePullRequest(input: UpdatePullRequestInput): Promise<PullSummary>
  createStack(repo: LinkedSandboxRepo, pullNumbers: readonly number[]): Promise<GithubStack>
  addToStack(
    repo: LinkedSandboxRepo,
    stackNumber: number,
    pullNumbers: readonly number[],
  ): Promise<GithubStack>
}

export function githubMirror(env: ShuttleEnv): MirrorGitHub {
  return {
    commitChangeset: (input) => commitChangeset(env, input),
    createPullRequest: (input) => createPullRequest(env, input),
    updatePullRequest: (input) => updatePullRequest(env, input),
    createStack: (repo, pullNumbers) => createStack(env, repo, pullNumbers),
    addToStack: (repo, stackNumber, pullNumbers) => addToStack(env, repo, stackNumber, pullNumbers),
  }
}

export interface PublishedLayerResult {
  readonly layer: number
  readonly branch: string
  readonly parentBranch: string
  readonly fullName: string
  readonly number: number
  readonly url: string
  readonly draft: boolean
  readonly remoteSha: string
  readonly publishedTree: string
  readonly outcome: PublishOutcome
  readonly installationId: number
  readonly title: string
  readonly body: string
  readonly headRef: string
  readonly headSha: string
  readonly baseRef: string
  readonly baseSha: string
  readonly additions: number
  readonly deletions: number
  readonly authorLogin: string
  readonly authorAvatarUrl: string
  readonly isFork: boolean
  readonly updatedAt: number
}

export interface MirrorInput {
  readonly title: string
  readonly body: string
  readonly draft: boolean
  /** Stack stamped at propose time; null publishes the worktree's current stack. */
  readonly stackId: number | null
  /** Layer the title and body describe; null means the current (or top) layer. */
  readonly layer: number | null
  /** Shuttle user who approved the publish; the commits are credited to them. */
  readonly authorUserId?: string | null
}

export interface MirroredStack {
  readonly stackId: number
  readonly layers: readonly PublishedLayerResult[]
  readonly stack: SessionRepoStack
}

/** Where a layer lives on GitHub: the commit and branch the next layer parents onto. */
interface RemoteParent {
  readonly sha: string
  readonly branch: string
}

/**
 * Seal the current layer (restacking above it), then mirror one stack to GitHub.
 *
 * Changeset rule: each layer's files are the local diff from its local parent
 * (session base for layer 1, layer n-1 branch otherwise), committed onto the
 * parent's GitHub commit. Layers below the lowest changed layer are unchanged,
 * so local and remote parent trees match. Empty deltas are skipped.
 */
export async function mirrorRepoStack(
  github: MirrorGitHub,
  sandbox: MirrorSandbox,
  runId: string,
  repo: LinkedSandboxRepo,
  input: MirrorInput,
  priorStacks: SessionStacks,
): Promise<MirroredStack> {
  await sandbox.sealLayer(runId, repo.name, input.title)

  const status = await sandbox.stackStatus(runId, repo.name, repo.defaultBranch)
  const stackId = input.stackId ?? status.currentStack
  const summary = status.stacks.find((entry) => entry.stack === stackId)
  const lastLayer = summary?.layers.at(-1)

  if (summary === undefined || lastLayer === undefined) {
    throw new Error(`Stack ${stackId} does not exist in ${repo.name}`)
  }

  if (summary.baseSha === '') {
    throw new Error(`No session base commit recorded for ${repo.name} stack ${stackId}`)
  }

  const targetLayer =
    input.layer ?? (stackId === status.currentStack ? status.currentLayer : lastLayer.layer)

  const prior = priorStacks[stackKey(repo.name, stackId)] ?? null
  const priorByLayer = new Map((prior?.layers ?? []).map((layer) => [layer.layer, layer]))

  const plan = planStackPublish(
    summary.layers.map((layer) => ({
      layer: layer.layer,
      branch: layer.branch,
      parentBranch: layer.parentBranch,
      localTree: layer.treeSha,
      publishedTree: priorByLayer.get(layer.layer)?.publishedTree ?? null,
    })),
  )

  const remoteByLayer = new Map<number, RemoteParent>([
    [0, { sha: summary.baseSha, branch: repo.defaultBranch }],
  ])

  for (const layer of prior?.layers ?? []) {
    if (layer.pull) {
      remoteByLayer.set(layer.layer, { sha: layer.remoteSha, branch: layer.branch })
    }
  }

  const published = new Map<number, PublishedLayerResult>()

  for (const planned of plan) {
    const remoteParent = remoteByLayer.get(planned.layer - 1)

    if (!remoteParent) {
      throw new Error(
        `Layer ${planned.layer - 1} of ${repo.name} stack ${stackId} has no published commit to stack on`,
      )
    }

    const localParent =
      planned.layer === 1
        ? summary.baseSha
        : summary.layers.find((layer) => layer.layer === planned.layer - 1)?.branch

    if (localParent === undefined || localParent === '') {
      throw new Error(`Layer ${planned.layer - 1} of ${repo.name} stack ${stackId} is missing`)
    }

    const { files } = await sandbox.layerChangeset(runId, repo.name, {
      parentRef: localParent,
      layerRef: planned.branch,
    })

    if (files.length === 0) {
      remoteByLayer.set(planned.layer, remoteParent)
      continue
    }

    const isTarget = planned.layer === targetLayer

    const committed = await github.commitChangeset({
      repo,
      baseSha: remoteParent.sha,
      branch: planned.branch,
      files,
      message: isTarget ? input.title : `Shuttle layer ${planned.layer}`,
      authorUserId: input.authorUserId ?? null,
    })

    remoteByLayer.set(planned.layer, { sha: committed.commitSha, branch: planned.branch })
    const priorPull = priorByLayer.get(planned.layer)?.pull

    const pull = priorPull
      ? await github.updatePullRequest({
          repo,
          number: priorPull.number,
          title: isTarget ? input.title : undefined,
          body: isTarget ? input.body : undefined,
          base: remoteParent.branch,
        })
      : await github.createPullRequest({
          repo,
          title: input.title,
          body: input.body,
          head: planned.branch,
          base: remoteParent.branch,
          draft: input.draft,
        })

    published.set(planned.layer, {
      layer: planned.layer,
      branch: planned.branch,
      parentBranch: remoteParent.branch,
      fullName: pull.fullName,
      number: pull.number,
      url: pull.url,
      draft: pull.draft,
      remoteSha: committed.commitSha,
      publishedTree: planned.localTree,
      outcome: priorPull ? 'updated' : 'opened',
      installationId: pull.installationId,
      title: pull.title,
      body: pull.body,
      headRef: pull.headRef,
      headSha: committed.commitSha,
      baseRef: pull.baseRef,
      baseSha: remoteParent.sha,
      additions: files.filter((file) => file.status !== 'deleted').length,
      deletions: files.filter((file) => file.status === 'deleted').length,
      authorLogin: pull.authorLogin,
      authorAvatarUrl: pull.authorAvatarUrl,
      isFork: pull.isFork,
      updatedAt: pull.updatedAt,
    })
  }

  const layers: SessionStackLayer[] = []
  const results: PublishedLayerResult[] = []

  for (const layer of summary.layers) {
    const fresh = published.get(layer.layer)
    const priorLayer = priorByLayer.get(layer.layer)

    if (fresh) {
      results.push(fresh)

      layers.push({
        layer: fresh.layer,
        branch: fresh.branch,
        parentBranch: fresh.parentBranch,
        pull: { number: fresh.number, url: fresh.url, draft: fresh.draft },
        remoteSha: fresh.remoteSha,
        publishedTree: fresh.publishedTree,
      })
    } else if (priorLayer) {
      layers.push(priorLayer)

      if (priorLayer.pull) {
        results.push(unchangedResult(layer, priorLayer, priorLayer.pull, repo, input))
      }
    }
  }

  const native =
    published.size > 0
      ? await registerNativeStack(github, repo, prior, layers)
      : (prior?.native ?? null)

  return { stackId, layers: results, stack: { layers, native } }
}

function unchangedResult(
  layer: StackStatusLayer,
  priorLayer: SessionStackLayer,
  pull: NonNullable<SessionStackLayer['pull']>,
  repo: LinkedSandboxRepo,
  input: MirrorInput,
): PublishedLayerResult {
  return {
    layer: layer.layer,
    branch: layer.branch,
    parentBranch: priorLayer.parentBranch,
    fullName: repo.fullName,
    number: pull.number,
    url: pull.url,
    draft: pull.draft,
    remoteSha: priorLayer.remoteSha,
    publishedTree: priorLayer.publishedTree,
    outcome: 'unchanged',
    installationId: repo.installationId,
    title: input.title,
    body: input.body,
    headRef: layer.branch,
    headSha: priorLayer.remoteSha,
    baseRef: priorLayer.parentBranch,
    baseSha: '',
    additions: 0,
    deletions: 0,
    authorLogin: 'shuttle[bot]',
    authorAvatarUrl: '',
    isFork: false,
    updatedAt: Date.now(),
  }
}

/** One GitHub stack per local stack; a single-PR stack (standalone PR) never registers. */
async function registerNativeStack(
  github: MirrorGitHub,
  repo: LinkedSandboxRepo,
  prior: SessionRepoStack | null,
  layers: readonly SessionStackLayer[],
): Promise<SessionRepoStack['native']> {
  const pullNumbers = layers.flatMap((layer) => (layer.pull ? [layer.pull.number] : []))
  const existing = prior?.native && 'number' in prior.native ? prior.native : null

  if (pullNumbers.length < 2) {
    return prior?.native ?? null
  }

  try {
    if (existing) {
      const already = new Set(
        (prior?.layers ?? []).flatMap((layer) => (layer.pull ? [layer.pull.number] : [])),
      )

      const added = pullNumbers.filter((number) => !already.has(number))

      if (added.length === 0) {
        return existing
      }

      const stack = await github.addToStack(repo, existing.number, added)
      return { number: stack.number, url: stack.url }
    }

    const stack = await github.createStack(repo, pullNumbers)
    return { number: stack.number, url: stack.url }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

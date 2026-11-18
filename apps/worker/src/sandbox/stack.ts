/**
 * Stack layer branch naming and local metadata keys.
 *
 * A session repo can hold several independent stacks. Each stack starts at the
 * session base commit, so a single-layer stack is a standalone PR.
 *
 * - Stack 1, layer 1 keeps `shuttle/<runId>/<repo>` so existing sessions keep working.
 * - Stack 1, layer 2+ use `shuttle/<runId>-stack/<repo>/<n>` so refs can't nest under layer 1.
 * - Stack 2+ use `shuttle/<runId>-stack<s>/<repo>/<n>` for every layer.
 */

export const BASE_CONFIG_KEY = 'shuttleBase'
/** On a review session's branch: the base commit of the pull request it has checked out. */
export const REVIEW_BASE_CONFIG_KEY = 'shuttleReviewBase'
export const PARENT_CONFIG_KEY = 'shuttleParent'
export const LAYER_CONFIG_KEY = 'shuttleLayer'

export interface LayerAddress {
  readonly stack: number
  readonly layer: number
}

export function branchForLayer(runId: string, repoName: string, address: LayerAddress): string {
  const { stack, layer } = address

  if (!Number.isInteger(stack) || stack < 1 || !Number.isInteger(layer) || layer < 1) {
    throw new Error(`Invalid stack layer ${stack}/${layer}`)
  }

  if (stack === 1) {
    return layer === 1
      ? `shuttle/${runId}/${repoName}`
      : `shuttle/${runId}-stack/${repoName}/${layer}`
  }

  return `shuttle/${runId}-stack${stack}/${repoName}/${layer}`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Parse a shuttle layer branch. Returns null for unrelated or non-canonical refs. */
export function parseLayerBranch(
  runId: string,
  repoName: string,
  branch: string,
): LayerAddress | null {
  if (branch === `shuttle/${runId}/${repoName}`) {
    return { stack: 1, layer: 1 }
  }

  const match = new RegExp(
    `^shuttle/${escapeRegExp(runId)}-stack([1-9][0-9]*)?/${escapeRegExp(repoName)}/([1-9][0-9]*)$`,
  ).exec(branch)

  if (!match) {
    return null
  }

  const stack = match[1] === undefined ? 1 : Number(match[1])
  const layer = Number(match[2])

  if ((stack === 1 && (match[1] !== undefined || layer < 2)) || !Number.isSafeInteger(layer)) {
    return null
  }

  return { stack, layer }
}

export function parentBranchForLayer(
  runId: string,
  repoName: string,
  address: LayerAddress,
  defaultBranch: string,
): string {
  return address.layer <= 1
    ? defaultBranch
    : branchForLayer(runId, repoName, { stack: address.stack, layer: address.layer - 1 })
}

export interface StackStatusLayer {
  readonly stack: number
  readonly layer: number
  readonly branch: string
  readonly parentBranch: string
  readonly tipSha: string
  readonly treeSha: string
  readonly pending: boolean
  readonly files: readonly string[]
}

export interface StackSummary {
  readonly stack: number
  /** Commit layer 1 forks from; GitHub already has it. */
  readonly baseSha: string
  /** Bottom → top. */
  readonly layers: readonly StackStatusLayer[]
}

export interface StackStatus {
  readonly repo: string
  readonly currentStack: number
  readonly currentLayer: number
  /** Layers of the current stack, bottom → top. */
  readonly layers: readonly StackStatusLayer[]
  readonly stacks: readonly StackSummary[]
  readonly pending: boolean
}

export interface RestackConflict {
  readonly layer: number
  readonly files: readonly string[]
}

export interface SealLayerResult {
  readonly sealed: boolean
  readonly tipSha: string
  readonly treeSha: string
  readonly message: string | null
}

export interface NewLayerResult {
  readonly stack: number
  readonly layer: number
  readonly branch: string
  readonly parentBranch: string
  readonly tipSha: string
}

export interface LayerChangesetInput {
  readonly parentRef: string
  readonly layerRef: string
}

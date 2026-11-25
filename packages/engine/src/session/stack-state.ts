import { Predicate } from 'effect'

import { asJson, isJsonObject, type JsonObject, type JsonValue } from '@swirls/looms/core'

import { jsonObject } from '../json'

export interface SessionStackLayer {
  readonly layer: number
  readonly branch: string
  readonly parentBranch: string
  readonly pull: {
    readonly number: number
    readonly url: string
    readonly draft: boolean
  } | null
  readonly remoteSha: string
  readonly publishedTree: string
}

export type SessionStackNative =
  | { readonly number: number; readonly url: string }
  | { readonly error: string }
  | null

export interface SessionRepoStack {
  readonly layers: readonly SessionStackLayer[]
  readonly native: SessionStackNative
}

/** Keyed by {@link stackKey}. */
export type SessionStacks = Readonly<Record<string, SessionRepoStack>>

export interface PendingPrPublish {
  readonly approvalId: string
  /** Agent thread that proposed the PR; published PRs link back to it. */
  readonly threadId: string | null
  readonly title: string
  readonly body: string
  readonly draft: boolean
  readonly repos: readonly string[]
  readonly repo: string | null
  /** Worktree current stack at propose time; null only when sandbox was unbound. */
  readonly stackId: number | null
  /** Worktree current layer at propose time; null only when sandbox was unbound. */
  readonly layer: number | null
  readonly parentPull: { readonly fullName: string; readonly number: number } | null
  readonly restacks: readonly number[]
  readonly status: 'awaiting_approval' | 'publishing'
  /** When a decision stops being accepted. Absent or null: never. */
  readonly expiresAt?: number | null
  /** Shuttle user who approved the publish; their GitHub account authors the commits. */
  readonly approvedBy?: string | null
}

export interface StackSessionSlice {
  readonly repos: readonly {
    readonly name: string
    readonly fullName: string
  }[]
  readonly pendingPrPublish: PendingPrPublish | null
  readonly stacks: SessionStacks
  readonly discardedPrApprovalId: string | null
  /**
   * The latest proposal taken up. A proposal reaches the session twice, as its own event and
   * again in its mailbox wake, and the second may come after the first was decided: it is the
   * same proposal, not a new one. Absent in sessions from before this was kept.
   */
  readonly proposedPrApprovalId?: string | null
}

/** Stack 1 keeps the bare repo name so sessions from before multi-stack still resolve. */
export function stackKey(repoName: string, stackId: number): string {
  return stackId === 1 ? repoName : `${repoName}#${stackId}`
}

/** True for a string that is neither missing nor empty. */
function isPresent(value: string | undefined | null): value is string {
  return value !== undefined && value !== null && value !== ''
}

function repoNameFrom(value: string | null | undefined): string | null {
  if (!isPresent(value)) {
    return null
  }

  return value.includes('/') ? (value.split('/')[1] ?? value) : value
}

function stackIdFrom(value: JsonValue | undefined): number {
  return Predicate.isNumber(value) && Number.isInteger(value) && value >= 1 ? value : 1
}

export interface StackContext {
  readonly parentPull: { readonly fullName: string; readonly number: number } | null
  readonly restacks: readonly number[]
}

/** Parent PR and PRs above `layer` that a publish of `layer` will touch. */
export function stackContextForLayer(
  stack: SessionRepoStack | undefined,
  layer: number,
  fullName: string,
): StackContext {
  if (!stack) {
    return { parentPull: null, restacks: [] }
  }

  const parent = layer > 1 ? stack.layers.find((entry) => entry.layer === layer - 1) : undefined

  return {
    parentPull: parent?.pull ? { fullName, number: parent.pull.number } : null,
    restacks: stack.layers.flatMap((entry) =>
      entry.layer > layer && entry.pull ? [entry.pull.number] : [],
    ),
  }
}

/**
 * Stamp a pending publish from `pr.proposed`. Stack and layer must come from the
 * worktree (via preparePrPublishGate); never guess from `stacks`.
 */
export function withPrProposal<S extends StackSessionSlice>(
  state: S,
  proposal: JsonObject,
  threadId: string | null,
): S {
  const approvalId = Predicate.isString(proposal.approvalId) ? proposal.approvalId : null

  if (
    !isPresent(approvalId) ||
    state.pendingPrPublish?.approvalId === approvalId ||
    state.proposedPrApprovalId === approvalId
  ) {
    return state
  }

  const repoName =
    repoNameFrom(Predicate.isString(proposal.repo) ? proposal.repo : null) ??
    state.repos[0]?.name ??
    null

  const layer = Predicate.isNumber(proposal.layer) ? proposal.layer : null
  const stackId = layer !== null ? stackIdFrom(proposal.stackId) : null

  const fallback: StackContext =
    isPresent(repoName) && stackId !== null && layer !== null
      ? stackContextForLayer(
          state.stacks[stackKey(repoName, stackId)],
          layer,
          state.repos.find((repo) => repo.name === repoName)?.fullName ?? repoName,
        )
      : { parentPull: null, restacks: [] }

  const parentFromProposal = isJsonObject(proposal.parentPull) ? proposal.parentPull : undefined

  const parentPull =
    parentFromProposal !== undefined &&
    Predicate.isString(parentFromProposal.fullName) &&
    Predicate.isNumber(parentFromProposal.number)
      ? { fullName: parentFromProposal.fullName, number: parentFromProposal.number }
      : fallback.parentPull

  const restacks = Array.isArray(proposal.restacks)
    ? proposal.restacks.filter(Predicate.isNumber)
    : fallback.restacks

  return {
    ...state,
    proposedPrApprovalId: approvalId,
    pendingPrPublish: {
      approvalId,
      threadId,
      title: Predicate.isString(proposal.title) ? proposal.title : 'Shuttle changes',
      body: Predicate.isString(proposal.body) ? proposal.body : '',
      draft: proposal.draft !== false,
      repos: Array.isArray(proposal.repos) ? proposal.repos.filter(Predicate.isString) : [],
      repo: repoName,
      stackId,
      layer,
      parentPull,
      restacks,
      status: 'awaiting_approval',
      expiresAt: Predicate.isNumber(proposal.expiresAt) ? proposal.expiresAt : null,
    },
  }
}

export function withPrPublishSettled<S extends StackSessionSlice>(state: S, approvalId: string): S {
  return state.pendingPrPublish !== null && state.pendingPrPublish.approvalId === approvalId
    ? { ...state, pendingPrPublish: null }
    : state
}

export function withStackPublished<S extends StackSessionSlice>(state: S, payload: JsonObject): S {
  const repo = Predicate.isString(payload.repo) ? payload.repo : null
  const layersRaw = Array.isArray(payload.layers) ? payload.layers : null

  if (!isPresent(repo) || layersRaw === null) {
    return state
  }

  const layers: SessionStackLayer[] = []

  for (const entry of layersRaw) {
    if (!isJsonObject(entry)) {
      continue
    }

    const layer = Predicate.isNumber(entry.layer) ? entry.layer : null
    const branch = Predicate.isString(entry.branch) ? entry.branch : null
    const parentBranch = Predicate.isString(entry.parentBranch) ? entry.parentBranch : null
    const remoteSha = Predicate.isString(entry.remoteSha) ? entry.remoteSha : null
    const publishedTree = Predicate.isString(entry.publishedTree) ? entry.publishedTree : null
    const pullObj = isJsonObject(entry.pull) ? entry.pull : null

    if (
      layer === null ||
      layer === 0 ||
      !isPresent(branch) ||
      !isPresent(parentBranch) ||
      !isPresent(remoteSha) ||
      !isPresent(publishedTree)
    ) {
      continue
    }

    layers.push({
      layer,
      branch,
      parentBranch,
      remoteSha,
      publishedTree,
      pull:
        pullObj !== null &&
        Predicate.isNumber(pullObj.number) &&
        Predicate.isString(pullObj.url) &&
        Predicate.isBoolean(pullObj.draft)
          ? { number: pullObj.number, url: pullObj.url, draft: pullObj.draft }
          : null,
    })
  }

  if (layers.length === 0) {
    return state
  }

  const key = stackKey(repo, stackIdFrom(payload.stackId))
  const stackRaw = isJsonObject(payload.stack) ? payload.stack : null

  let native: SessionStackNative = state.stacks[key]?.native ?? null

  if (stackRaw !== null) {
    if (Predicate.isNumber(stackRaw.number) && Predicate.isString(stackRaw.url)) {
      native = { number: stackRaw.number, url: stackRaw.url }
    } else if (Predicate.isString(stackRaw.error)) {
      native = { error: stackRaw.error }
    }
  }

  return {
    ...state,
    stacks: {
      ...state.stacks,
      [key]: { layers, native },
    },
  }
}

/** Narrow JSON record helper for effect payloads that carry stacks. */
export function stacksAsJson(stacks: SessionStacks): {
  readonly [key: string]: JsonValue
} {
  return jsonObject(asJson(stacks))
}

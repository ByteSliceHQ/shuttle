/**
 * How an approval is decided, and how long it may wait: the host port for approvals.
 *
 * A standalone Shuttle waits for a person for as long as it takes. A host that runs sessions
 * unattended, or that bills for a session's time, says how long a question may stay open, and a
 * decision that arrives after that is refused: nothing it would have approved is done. A host
 * that runs sessions for agents of its own can also decide a gate itself, by policy, at the
 * moment it opens.
 */
export type ApprovalKind = 'publish-pull-request' | 'submit-review'

export interface ApprovalRequestInfo {
  readonly kind: ApprovalKind
  readonly approvalId: string
  /** The organization the session belongs to, when it has one. */
  readonly orgId: string | null
}

/** A pull request a session proposes to open, or to update when the layer already has one. */
export interface PullRequestProposal {
  readonly title: string
  readonly body: string
  readonly draft: boolean
  /** Every repository publishing would push to, as `owner/name`. */
  readonly repositories: readonly string[]
  /** The branch the pull request is opened from. Null when the session has no worktree yet. */
  readonly branch: string | null
  /** The branch it is opened against: the default branch, or the layer below in a stack. */
  readonly baseBranch: string | null
  /** Where the proposal sits in the session's stack. Null when the session has no worktree yet. */
  readonly stack: {
    readonly id: number
    readonly layer: number
    /** The pull request of the layer below, when this one stacks on it. */
    readonly parentPullRequest: { readonly repository: string; readonly number: number } | null
    /** Pull requests of the layers above, which publishing restacks. */
    readonly restacks: readonly number[]
  } | null
  /** The pull request this layer already has, which publishing updates instead of opening one. */
  readonly existingPullRequest: { readonly number: number; readonly url: string } | null
}

/** A pull request review an agent has drafted and asks to submit. */
export interface ReviewProposal {
  /** `owner/name` of the repository the pull request is in. */
  readonly repository: string
  readonly number: number
  readonly verdict: 'approve' | 'request_changes' | 'comment'
  readonly summary: string
  readonly commentCount: number
}

interface ApprovalDecisionBase extends ApprovalRequestInfo {
  /** The person the session acts for. Null when it is an organization's, with no person behind it. */
  readonly ownerId: string | null
  /** The `metadata` the host gave `startHeadlessSession`. Empty for a session it did not start. */
  readonly hostMetadata: Readonly<Record<string, string>>
}

/** A gate that has just opened, with what it asks to do. */
export type ApprovalDecisionRequest =
  | (ApprovalDecisionBase & {
      readonly kind: 'publish-pull-request'
      readonly proposal: PullRequestProposal
    })
  | (ApprovalDecisionBase & {
      readonly kind: 'submit-review'
      readonly proposal: ReviewProposal
    })

/** What a policy says of a gate. `undecided` leaves it open for someone to answer. */
export type ApprovalVerdict = 'approve' | 'reject' | 'undecided'

export interface ApprovalPolicy {
  /** Milliseconds from the request after which a decision is refused. Null: it never expires. */
  expiresAfterMs(request: ApprovalRequestInfo): number | null
  /**
   * Decides a gate when it opens, in place of a person. `approve` and `reject` settle it at once,
   * recorded as decided by {@link POLICY_DECIDER}. `undecided`, leaving this out, or throwing
   * leaves the gate open: the session is blocked until it is answered, or the approval expires.
   *
   * Asked once for each gate, from an effect, and the answer is recorded on the run: it is never
   * asked again for the same gate when the run is replayed.
   */
  decide?(request: ApprovalDecisionRequest): Promise<ApprovalVerdict>
}

/**
 * Who a decision made by the host's `decide` is recorded as: the `actorId` of the
 * `approval.decided` event's origin. No person has this id.
 */
export const POLICY_DECIDER = 'host-policy'

/** Shuttle's own behaviour: an approval never expires, and a person decides it. */
export const neverExpire: ApprovalPolicy = { expiresAfterMs: () => null }

/** When the approval `request` made at `now` stops accepting decisions. Null: never. */
export function expiryOf(
  policy: ApprovalPolicy,
  request: ApprovalRequestInfo,
  now: number,
): number | null {
  const ttl = policy.expiresAfterMs(request)

  return ttl === null || !Number.isFinite(ttl) ? null : now + Math.max(0, ttl)
}

/** Whether a decision made at `at` comes too late for an approval that expires at `expiresAt`. */
export function hasExpired(expiresAt: number | null | undefined, at: number): boolean {
  return expiresAt !== null && expiresAt !== undefined && at > expiresAt
}

/**
 * What the host's policy decides of `request`, or null when the gate is left for someone to
 * answer: the policy has no `decide`, it said `undecided` (or anything else), or it threw.
 */
export async function policyDecision(
  policy: ApprovalPolicy,
  request: ApprovalDecisionRequest,
): Promise<'approve' | 'reject' | null> {
  if (policy.decide === undefined) {
    return null
  }

  try {
    const verdict = await policy.decide(request)

    return verdict === 'approve' || verdict === 'reject' ? verdict : null
  } catch (cause) {
    console.warn(`the approvals port could not decide ${request.approvalId}`, cause)

    return null
  }
}

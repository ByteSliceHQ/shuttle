/**
 * How long an approval may wait for a decision: the host port for approval expiry.
 *
 * A standalone Shuttle waits for a person for as long as it takes. A host that runs sessions
 * unattended, or that bills for a session's time, says how long a question may stay open, and a
 * decision that arrives after that is refused: nothing it would have approved is done.
 */
export type ApprovalKind = 'publish-pull-request'

export interface ApprovalRequestInfo {
  readonly kind: ApprovalKind
  readonly approvalId: string
  /** The organization the session belongs to, when it has one. */
  readonly orgId: string | null
}

export interface ApprovalPolicy {
  /** Milliseconds from the request after which a decision is refused. Null: it never expires. */
  expiresAfterMs(request: ApprovalRequestInfo): number | null
}

/** Shuttle's own behaviour: an approval never expires. */
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

import type { ShuttleEnv } from '../env'
import { base64Url } from './client'

export type NormalizedWebhook =
  | {
      readonly kind: 'pull.upserted'
      readonly deliveryId: string
      readonly installationId: number
      readonly fullName: string
      readonly number: number
      readonly action:
        | 'opened'
        | 'ready_for_review'
        | 'synchronize'
        | 'edited'
        | 'reopened'
        | 'converted_to_draft'
      readonly title: string
      readonly body: string
      readonly url: string
      readonly draft: boolean
      readonly authorLogin: string
      readonly authorAvatarUrl: string
      readonly headRef: string
      readonly headSha: string
      readonly baseRef: string
      readonly baseSha: string
      readonly additions: number
      readonly deletions: number
      readonly updatedAt: number
      readonly isFork: boolean
      readonly stack: {
        readonly number: number
        readonly position: number
        readonly size: number
      } | null
    }
  | {
      readonly kind: 'pull.closed'
      readonly deliveryId: string
      readonly installationId: number
      readonly fullName: string
      readonly number: number
      readonly updatedAt: number
    }
  | {
      readonly kind: 'review.submitted'
      readonly deliveryId: string
      readonly installationId: number
      readonly fullName: string
      readonly number: number
      readonly verdict: 'approved' | 'changes_requested' | 'commented'
      readonly updatedAt: number
    }
  | {
      readonly kind: 'checks.updated'
      readonly deliveryId: string
      readonly installationId: number
      readonly fullName: string
      readonly headSha: string
      readonly checkRollup: 'passing' | 'failing' | 'pending' | 'neutral'
      readonly updatedAt: number
    }
  | {
      readonly kind: 'comment.upserted'
      readonly deliveryId: string
      readonly installationId: number
      readonly fullName: string
      readonly number: number
      readonly comment: WebhookComment
    }
  | {
      readonly kind: 'comment.removed'
      readonly deliveryId: string
      readonly installationId: number
      readonly fullName: string
      readonly number: number
      readonly commentId: number
    }
  | {
      readonly kind: 'thread.resolution'
      readonly deliveryId: string
      readonly installationId: number
      readonly fullName: string
      readonly number: number
      readonly rootId: number
      readonly resolved: boolean
      readonly updatedAt: number
    }
  | {
      readonly kind: 'ignored'
      readonly deliveryId: string
      readonly reason: string
    }

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Constant-time compare of two hex/signature strings. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false
  }

  let mismatch = 0

  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index)
  }

  return mismatch === 0
}

export async function verifyWebhookSignature(
  env: ShuttleEnv,
  rawBody: string,
  signatureHeader: string | null,
): Promise<boolean> {
  const secret = env.GITHUB_WEBHOOK_SECRET

  if (!secret || !signatureHeader?.startsWith('sha256=')) {
    return false
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody))
  const expected = `sha256=${hex(signature)}`
  return timingSafeEqual(expected, signatureHeader)
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function installationIdFrom(payload: Record<string, unknown>): number {
  const installation = asObject(payload.installation)
  return asNumber(installation?.id)
}

function fullNameFromRepo(payload: Record<string, unknown>): string {
  const repo = asObject(payload.repository)
  return asString(repo?.full_name)
}

function mapCheckConclusion(
  conclusion: string | null,
  status: string,
): 'passing' | 'failing' | 'pending' | 'neutral' {
  if (status !== 'completed') {
    return 'pending'
  }

  switch (conclusion) {
    case 'success':
      return 'passing'
    case 'neutral':
    case 'skipped':
      return 'neutral'
    case 'failure':
    case 'timed_out':
    case 'cancelled':
    case 'action_required':
    case 'stale':
      return 'failing'
    default:
      return 'neutral'
  }
}

/** A review comment as GitHub's REST payloads carry it. */
export interface WebhookComment {
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
}

/** Reads a review comment in the shape GitHub's REST API and its webhooks both use. */
export function commentFromWebhook(comment: Record<string, unknown>): WebhookComment {
  const commentId = asNumber(comment.id)
  const user = asObject(comment.user)
  const line = typeof comment.line === 'number' ? comment.line : null
  const original = typeof comment.original_line === 'number' ? comment.original_line : null
  const now = new Date().toISOString()

  const start =
    typeof comment.start_line === 'number'
      ? comment.start_line
      : typeof comment.original_start_line === 'number'
        ? comment.original_start_line
        : null

  return {
    commentId,
    // A reply names the comment it answers; GitHub threads are one level deep.
    rootId: asNumber(comment.in_reply_to_id) || commentId,
    path: asString(comment.path),
    // GitHub drops the line once the code under a comment changes, keeping where it was.
    line: line ?? original,
    ...(start === null ? {} : { startLine: start }),
    side: asString(comment.side).toUpperCase() === 'LEFT' ? 'LEFT' : 'RIGHT',
    outdated: line === null,
    body: asString(comment.body),
    author: { login: asString(user?.login, 'unknown'), avatarUrl: asString(user?.avatar_url) },
    createdAt: Date.parse(asString(comment.created_at, now)),
    updatedAt: Date.parse(asString(comment.updated_at, now)),
    url: asString(comment.html_url),
  }
}

export function normalizeWebhook(
  eventName: string,
  deliveryId: string,
  payload: unknown,
): NormalizedWebhook {
  const body = asObject(payload)

  if (!body) {
    return { kind: 'ignored', deliveryId, reason: 'non-object-payload' }
  }

  switch (eventName) {
    case 'pull_request': {
      const action = asString(body.action)
      const pull = asObject(body.pull_request)

      if (!pull) {
        return { kind: 'ignored', deliveryId, reason: 'missing-pull_request' }
      }

      const installationId = installationIdFrom(body)
      const fullName = fullNameFromRepo(body)
      const number = asNumber(pull.number)
      const updatedAt = Date.parse(asString(pull.updated_at, new Date().toISOString()))
      const user = asObject(pull.user)
      const head = asObject(pull.head)
      const base = asObject(pull.base)
      const headRepo = asObject(head?.repo)

      if (action === 'closed') {
        return {
          kind: 'pull.closed',
          deliveryId,
          installationId,
          fullName,
          number,
          updatedAt,
        }
      }

      const upsertActions = new Set([
        'opened',
        'ready_for_review',
        'synchronize',
        'edited',
        'reopened',
        'converted_to_draft',
      ])

      if (!upsertActions.has(action)) {
        return { kind: 'ignored', deliveryId, reason: `pull_request.${action}` }
      }

      return {
        kind: 'pull.upserted',
        deliveryId,
        installationId,
        fullName,
        number,
        action: action as
          | 'opened'
          | 'ready_for_review'
          | 'synchronize'
          | 'edited'
          | 'reopened'
          | 'converted_to_draft',
        title: asString(pull.title),
        body: asString(pull.body),
        url: asString(pull.html_url),
        draft: Boolean(pull.draft),
        authorLogin: asString(user?.login, 'unknown'),
        authorAvatarUrl: asString(user?.avatar_url),
        headRef: asString(head?.ref),
        headSha: asString(head?.sha),
        baseRef: asString(base?.ref),
        baseSha: asString(base?.sha),
        additions: asNumber(pull.additions),
        deletions: asNumber(pull.deletions),
        updatedAt,
        isFork: Boolean(headRepo?.fork),
        stack: stackFromWebhook(pull),
      }
    }

    case 'pull_request_review': {
      if (asString(body.action) !== 'submitted') {
        return {
          kind: 'ignored',
          deliveryId,
          reason: `pull_request_review.${asString(body.action)}`,
        }
      }

      const pull = asObject(body.pull_request)
      const review = asObject(body.review)

      if (!pull || !review) {
        return { kind: 'ignored', deliveryId, reason: 'missing-review' }
      }

      const state = asString(review.state).toUpperCase()
      let verdict: 'approved' | 'changes_requested' | 'commented'

      switch (state) {
        case 'APPROVED':
          verdict = 'approved'
          break
        case 'CHANGES_REQUESTED':
          verdict = 'changes_requested'
          break
        default:
          verdict = 'commented'
          break
      }

      return {
        kind: 'review.submitted',
        deliveryId,
        installationId: installationIdFrom(body),
        fullName: fullNameFromRepo(body),
        number: asNumber(pull.number),
        verdict,
        updatedAt: Date.parse(asString(review.submitted_at, new Date().toISOString())),
      }
    }

    case 'check_suite': {
      const suite = asObject(body.check_suite)

      if (!suite) {
        return { kind: 'ignored', deliveryId, reason: 'missing-check_suite' }
      }

      const conclusion = typeof suite.conclusion === 'string' ? suite.conclusion : null
      const status = asString(suite.status, 'queued')
      const headSha = asString(suite.head_sha)

      return {
        kind: 'checks.updated',
        deliveryId,
        installationId: installationIdFrom(body),
        fullName: fullNameFromRepo(body),
        headSha,
        checkRollup: mapCheckConclusion(conclusion, status),
        updatedAt: Date.now(),
      }
    }

    case 'pull_request_review_comment': {
      const action = asString(body.action)
      const pull = asObject(body.pull_request)
      const comment = asObject(body.comment)
      const commentId = asNumber(comment?.id)

      if (!pull || !comment || !commentId) {
        return { kind: 'ignored', deliveryId, reason: 'missing-comment' }
      }

      const target = {
        deliveryId,
        installationId: installationIdFrom(body),
        fullName: fullNameFromRepo(body),
        number: asNumber(pull.number),
      }

      if (action === 'deleted') {
        return { kind: 'comment.removed', ...target, commentId }
      }

      if (action !== 'created' && action !== 'edited') {
        return { kind: 'ignored', deliveryId, reason: `pull_request_review_comment.${action}` }
      }

      return { kind: 'comment.upserted', ...target, comment: commentFromWebhook(comment) }
    }

    case 'pull_request_review_thread': {
      const action = asString(body.action)
      const pull = asObject(body.pull_request)
      const thread = asObject(body.thread)
      const comments = Array.isArray(thread?.comments) ? thread.comments : []
      const rootId = asNumber(asObject(comments[0])?.id)

      if (!pull || !rootId || (action !== 'resolved' && action !== 'unresolved')) {
        return { kind: 'ignored', deliveryId, reason: `pull_request_review_thread.${action}` }
      }

      return {
        kind: 'thread.resolution',
        deliveryId,
        installationId: installationIdFrom(body),
        fullName: fullNameFromRepo(body),
        number: asNumber(pull.number),
        rootId,
        resolved: action === 'resolved',
        updatedAt: Date.parse(asString(pull.updated_at, new Date().toISOString())),
      }
    }

    case 'installation_repositories':
    case 'ping':
      return { kind: 'ignored', deliveryId, reason: eventName }

    default:
      return { kind: 'ignored', deliveryId, reason: `unhandled:${eventName}` }
  }
}

function stackFromWebhook(
  pull: Record<string, unknown> | null,
): { number: number; position: number; size: number } | null {
  if (!pull) {
    return null
  }

  const stack = asObject(pull.stack)

  if (!stack) {
    return null
  }

  const number = asNumber(stack.number)
  const position = asNumber(stack.position)
  const size = asNumber(stack.size)

  if (!number || !position || !size) {
    return null
  }

  return { number, position, size }
}

/** @internal — re-export for tests that need base64 helpers. */
export { base64Url }

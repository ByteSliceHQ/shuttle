import { z } from 'zod'

import type { GitEnv } from '../env'
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
  env: GitEnv,
  rawBody: string,
  signatureHeader: string | null,
): Promise<boolean> {
  const secret = env.GITHUB_WEBHOOK_SECRET

  if (
    secret === undefined ||
    secret === '' ||
    signatureHeader === null ||
    !signatureHeader.startsWith('sha256=')
  ) {
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

/*
 * GitHub's payloads are read leniently: a field that is missing or not the expected kind reads as
 * absent, and the code below chooses the fallback. An object that is not an object reads as absent.
 */
const Text = z.string().optional().catch(undefined)
const Count = z.number().optional().catch(undefined)
const Flag = z.boolean().optional().catch(undefined)
const Line = z.number().nullish().catch(undefined)

function lenientObject<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.object(shape).optional().catch(undefined)
}

const UserSchema = lenientObject({ login: Text, avatar_url: Text })

/** A review comment as GitHub's REST API and its webhooks both carry it. */
export const ReviewCommentSchema = z.object({
  id: Count,
  in_reply_to_id: Count,
  path: Text,
  line: Line,
  original_line: Line,
  start_line: Line,
  original_start_line: Line,
  side: Text,
  body: Text,
  user: UserSchema,
  created_at: Text,
  updated_at: Text,
  html_url: Text,
})

export type ReviewCommentPayload = z.infer<typeof ReviewCommentSchema>

/** What the webhook events Shuttle reads carry between them. */
export const WebhookPayloadSchema = z.object({
  action: Text,
  installation: lenientObject({ id: Count }),
  repository: lenientObject({ full_name: Text }),
  pull_request: lenientObject({
    number: Count,
    title: Text,
    body: Text,
    html_url: Text,
    draft: Flag,
    updated_at: Text,
    additions: Count,
    deletions: Count,
    user: UserSchema,
    head: lenientObject({
      ref: Text,
      sha: Text,
      repo: lenientObject({ fork: Flag }),
    }),
    base: lenientObject({ ref: Text, sha: Text }),
    stack: lenientObject({ number: Count, position: Count, size: Count }),
  }),
  review: lenientObject({ state: Text, submitted_at: Text }),
  check_suite: lenientObject({ conclusion: Text, status: Text, head_sha: Text }),
  comment: lenientObject(ReviewCommentSchema.shape),
  thread: lenientObject({ comments: z.array(lenientObject({ id: Count })).catch([]) }),
})

export type WebhookPayload = z.infer<typeof WebhookPayloadSchema>

export type WebhookBody =
  | { readonly kind: 'payload'; readonly payload: WebhookPayload }
  | { readonly kind: 'invalid-json' }
  | { readonly kind: 'non-object-payload' }

/** Reads a delivery's raw body into the payload the events are normalized from. */
export function parseWebhookBody(rawBody: string): WebhookBody {
  try {
    const parsed = WebhookPayloadSchema.safeParse(JSON.parse(rawBody))

    return parsed.success
      ? { kind: 'payload', payload: parsed.data }
      : { kind: 'non-object-payload' }
  } catch {
    return { kind: 'invalid-json' }
  }
}

function installationIdFrom(payload: WebhookPayload): number {
  return payload.installation?.id ?? 0
}

function fullNameFromRepo(payload: WebhookPayload): string {
  return payload.repository?.full_name ?? ''
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
    case null:
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
export function commentFromWebhook(comment: ReviewCommentPayload): WebhookComment {
  const commentId = comment.id ?? 0
  const replyTo = comment.in_reply_to_id ?? 0
  const line = comment.line ?? null
  const original = comment.original_line ?? null
  const now = new Date().toISOString()
  const start = comment.start_line ?? comment.original_start_line ?? null

  return {
    commentId,
    // A reply names the comment it answers; GitHub threads are one level deep.
    rootId: replyTo === 0 ? commentId : replyTo,
    path: comment.path ?? '',
    // GitHub drops the line once the code under a comment changes, keeping where it was.
    line: line ?? original,
    startLine: start ?? undefined,
    side: (comment.side ?? '').toUpperCase() === 'LEFT' ? 'LEFT' : 'RIGHT',
    outdated: line === null,
    body: comment.body ?? '',
    author: {
      login: comment.user?.login ?? 'unknown',
      avatarUrl: comment.user?.avatar_url ?? '',
    },
    createdAt: Date.parse(comment.created_at ?? now),
    updatedAt: Date.parse(comment.updated_at ?? now),
    url: comment.html_url ?? '',
  }
}

const UpsertActionSchema = z.enum([
  'opened',
  'ready_for_review',
  'synchronize',
  'edited',
  'reopened',
  'converted_to_draft',
])

export function normalizeWebhook(
  eventName: string,
  deliveryId: string,
  body: WebhookPayload,
): NormalizedWebhook {
  switch (eventName) {
    case 'pull_request': {
      const action = body.action ?? ''
      const pull = body.pull_request

      if (pull === undefined) {
        return { kind: 'ignored', deliveryId, reason: 'missing-pull_request' }
      }

      const installationId = installationIdFrom(body)
      const fullName = fullNameFromRepo(body)
      const number = pull.number ?? 0
      const updatedAt = Date.parse(pull.updated_at ?? new Date().toISOString())

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

      const upsertAction = UpsertActionSchema.safeParse(action)

      if (!upsertAction.success) {
        return { kind: 'ignored', deliveryId, reason: `pull_request.${action}` }
      }

      return {
        kind: 'pull.upserted',
        deliveryId,
        installationId,
        fullName,
        number,
        action: upsertAction.data,
        title: pull.title ?? '',
        body: pull.body ?? '',
        url: pull.html_url ?? '',
        draft: pull.draft === true,
        authorLogin: pull.user?.login ?? 'unknown',
        authorAvatarUrl: pull.user?.avatar_url ?? '',
        headRef: pull.head?.ref ?? '',
        headSha: pull.head?.sha ?? '',
        baseRef: pull.base?.ref ?? '',
        baseSha: pull.base?.sha ?? '',
        additions: pull.additions ?? 0,
        deletions: pull.deletions ?? 0,
        updatedAt,
        isFork: pull.head?.repo?.fork === true,
        stack: stackFromWebhook(pull),
      }
    }

    case 'pull_request_review': {
      if (body.action !== 'submitted') {
        return {
          kind: 'ignored',
          deliveryId,
          reason: `pull_request_review.${body.action ?? ''}`,
        }
      }

      const pull = body.pull_request
      const review = body.review

      if (pull === undefined || review === undefined) {
        return { kind: 'ignored', deliveryId, reason: 'missing-review' }
      }

      const state = (review.state ?? '').toUpperCase()
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
        number: pull.number ?? 0,
        verdict,
        updatedAt: Date.parse(review.submitted_at ?? new Date().toISOString()),
      }
    }

    case 'check_suite': {
      const suite = body.check_suite

      if (suite === undefined) {
        return { kind: 'ignored', deliveryId, reason: 'missing-check_suite' }
      }

      const conclusion = suite.conclusion ?? null
      const status = suite.status ?? 'queued'
      const headSha = suite.head_sha ?? ''

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
      const action = body.action ?? ''
      const pull = body.pull_request
      const comment = body.comment
      const commentId = comment?.id ?? 0

      if (pull === undefined || comment === undefined || commentId === 0) {
        return { kind: 'ignored', deliveryId, reason: 'missing-comment' }
      }

      const target = {
        deliveryId,
        installationId: installationIdFrom(body),
        fullName: fullNameFromRepo(body),
        number: pull.number ?? 0,
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
      const action = body.action ?? ''
      const pull = body.pull_request
      const rootId = body.thread?.comments[0]?.id ?? 0

      if (
        pull === undefined ||
        rootId === 0 ||
        (action !== 'resolved' && action !== 'unresolved')
      ) {
        return { kind: 'ignored', deliveryId, reason: `pull_request_review_thread.${action}` }
      }

      return {
        kind: 'thread.resolution',
        deliveryId,
        installationId: installationIdFrom(body),
        fullName: fullNameFromRepo(body),
        number: pull.number ?? 0,
        rootId,
        resolved: action === 'resolved',
        updatedAt: Date.parse(pull.updated_at ?? new Date().toISOString()),
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
  pull: NonNullable<WebhookPayload['pull_request']>,
): { number: number; position: number; size: number } | null {
  const stack = pull.stack

  if (stack === undefined) {
    return null
  }

  const number = stack.number ?? 0
  const position = stack.position ?? 0
  const size = stack.size ?? 0

  if (number === 0 || position === 0 || size === 0) {
    return null
  }

  return { number, position, size }
}

/** @internal — re-export for tests that need base64 helpers. */
export { base64Url }

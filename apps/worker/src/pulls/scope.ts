import { Schema } from 'effect'

import { agentCatalog } from '@swirls/looms/agent'
import { approvalCatalog } from '@swirls/looms/approval'
import { createModuleScope, defineEventCatalog } from '@swirls/looms/core'

export const AutoReviewModeSchema = Schema.Union([
  Schema.Literal('off'),
  Schema.Literal('others'),
  Schema.Literal('all'),
])

export const PullLinkedRoleSchema = Schema.Union([
  Schema.Literal('author'),
  Schema.Literal('reviewer'),
])

export const ReviewDecisionSchema = Schema.Union([
  Schema.Literal('approved'),
  Schema.Literal('changes_requested'),
  Schema.Literal('review_required'),
  Schema.Literal('none'),
])

export const CheckRollupSchema = Schema.Union([
  Schema.Literal('passing'),
  Schema.Literal('failing'),
  Schema.Literal('pending'),
  Schema.Literal('neutral'),
])

export const PullUpsertActionSchema = Schema.Union([
  Schema.Literal('opened'),
  Schema.Literal('ready_for_review'),
  Schema.Literal('synchronize'),
  Schema.Literal('edited'),
  Schema.Literal('reopened'),
  Schema.Literal('converted_to_draft'),
  Schema.Literal('synced'),
])

const PullAuthorSchema = Schema.Struct({
  login: Schema.String,
  avatarUrl: Schema.String,
})

export const pullsCatalog = defineEventCatalog('pulls', {
  'pull.upserted': Schema.Struct({
    installationId: Schema.Finite,
    fullName: Schema.String,
    number: Schema.Finite,
    action: PullUpsertActionSchema,
    title: Schema.String,
    body: Schema.String,
    url: Schema.String,
    draft: Schema.Boolean,
    author: PullAuthorSchema,
    headRef: Schema.String,
    headSha: Schema.String,
    baseRef: Schema.String,
    baseSha: Schema.String,
    additions: Schema.Finite,
    deletions: Schema.Finite,
    reviewDecision: ReviewDecisionSchema,
    checkRollup: CheckRollupSchema,
    updatedAt: Schema.Finite,
    isFork: Schema.Boolean,
    state: Schema.Union([Schema.Literal('open'), Schema.Literal('closed')]),
    stack: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          number: Schema.Finite,
          position: Schema.Finite,
          size: Schema.Finite,
        }),
      ),
    ),
  }),
  'pull.closed': Schema.Struct({
    fullName: Schema.String,
    number: Schema.Finite,
    updatedAt: Schema.Finite,
  }),
  'checks.updated': Schema.Struct({
    fullName: Schema.String,
    headSha: Schema.String,
    checkRollup: CheckRollupSchema,
    updatedAt: Schema.Finite,
  }),
  'review.submitted': Schema.Struct({
    fullName: Schema.String,
    number: Schema.Finite,
    verdict: Schema.Union([
      Schema.Literal('approved'),
      Schema.Literal('changes_requested'),
      Schema.Literal('commented'),
    ]),
    updatedAt: Schema.Finite,
  }),
  'pull.linked': Schema.Struct({
    fullName: Schema.String,
    number: Schema.Finite,
    runId: Schema.String,
    role: PullLinkedRoleSchema,
    /** Agent thread inside the session that opened or reviewed the PR. */
    threadId: Schema.optional(Schema.String),
  }),
  'repo.policy.set': Schema.Struct({
    fullName: Schema.String,
    installationId: Schema.Finite,
    folders: Schema.Array(
      Schema.Struct({
        folderId: Schema.String,
        autoReview: AutoReviewModeSchema,
      }),
    ),
  }),
  'review.requested': Schema.Struct({
    fullName: Schema.String,
    number: Schema.Finite,
    headSha: Schema.String,
    folderId: Schema.String,
    runId: Schema.String,
    at: Schema.Finite,
  }),
})

export const pullsModule = createModuleScope({
  namespace: 'pulls',
  protocolVersion: '1.0.0',
  description: 'GitHub pull request inbox state and Shuttle session links.',
  events: pullsCatalog,
  observes: [agentCatalog, approvalCatalog],
})

export type AutoReviewMode = 'off' | 'others' | 'all'
export type PullLinkedRole = 'author' | 'reviewer'

export function pullKey(fullName: string, number: number): string {
  return `${fullName}#${number}`
}

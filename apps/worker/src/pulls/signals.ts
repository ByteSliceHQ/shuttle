import { Schema } from 'effect'

import {
  AutoReviewModeSchema,
  CheckRollupSchema,
  PullCommentSchema,
  PullLinkedRoleSchema,
  PullUpsertActionSchema,
  ReviewDecisionSchema,
  pullsModule,
} from './scope'

const PullAuthorSchema = Schema.Struct({
  login: Schema.String,
  avatarUrl: Schema.String,
})

export const ingestWebhook = pullsModule.signal({
  description: 'Ingest a normalized GitHub webhook delivery.',
  input: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal('pull.upserted'),
      deliveryId: Schema.String,
      installationId: Schema.Finite,
      fullName: Schema.String,
      number: Schema.Finite,
      action: PullUpsertActionSchema,
      title: Schema.String,
      body: Schema.String,
      url: Schema.String,
      draft: Schema.Boolean,
      authorLogin: Schema.String,
      authorAvatarUrl: Schema.String,
      headRef: Schema.String,
      headSha: Schema.String,
      baseRef: Schema.String,
      baseSha: Schema.String,
      additions: Schema.Finite,
      deletions: Schema.Finite,
      updatedAt: Schema.Finite,
      isFork: Schema.Boolean,
      reviewDecision: Schema.optional(ReviewDecisionSchema),
      checkRollup: Schema.optional(CheckRollupSchema),
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
    Schema.Struct({
      kind: Schema.Literal('pull.closed'),
      deliveryId: Schema.String,
      installationId: Schema.Finite,
      fullName: Schema.String,
      number: Schema.Finite,
      updatedAt: Schema.Finite,
    }),
    Schema.Struct({
      kind: Schema.Literal('review.submitted'),
      deliveryId: Schema.String,
      installationId: Schema.Finite,
      fullName: Schema.String,
      number: Schema.Finite,
      verdict: Schema.Union([
        Schema.Literal('approved'),
        Schema.Literal('changes_requested'),
        Schema.Literal('commented'),
      ]),
      updatedAt: Schema.Finite,
    }),
    Schema.Struct({
      kind: Schema.Literal('checks.updated'),
      deliveryId: Schema.String,
      installationId: Schema.Finite,
      fullName: Schema.String,
      headSha: Schema.String,
      checkRollup: CheckRollupSchema,
      updatedAt: Schema.Finite,
    }),
  ]),
  build: (input) => {
    switch (input.kind) {
      case 'pull.upserted':
        return pullsModule.input(
          'pull.upserted',
          {
            installationId: input.installationId,
            fullName: input.fullName,
            number: input.number,
            action: input.action,
            title: input.title,
            body: input.body,
            url: input.url,
            draft: input.draft,
            author: { login: input.authorLogin, avatarUrl: input.authorAvatarUrl },
            headRef: input.headRef,
            headSha: input.headSha,
            baseRef: input.baseRef,
            baseSha: input.baseSha,
            additions: input.additions,
            deletions: input.deletions,
            reviewDecision: input.reviewDecision ?? 'none',
            checkRollup: input.checkRollup ?? 'neutral',
            updatedAt: input.updatedAt,
            isFork: input.isFork,
            state: 'open' as const,
            ...(input.stack !== undefined ? { stack: input.stack } : {}),
          },
          { idempotencyKey: `pulls-delivery:${input.deliveryId}` },
        )
      case 'pull.closed':
        return pullsModule.input(
          'pull.closed',
          {
            fullName: input.fullName,
            number: input.number,
            updatedAt: input.updatedAt,
          },
          { idempotencyKey: `pulls-delivery:${input.deliveryId}` },
        )
      case 'review.submitted':
        return pullsModule.input(
          'review.submitted',
          {
            fullName: input.fullName,
            number: input.number,
            verdict: input.verdict,
            updatedAt: input.updatedAt,
          },
          { idempotencyKey: `pulls-delivery:${input.deliveryId}` },
        )
      case 'checks.updated':
        return pullsModule.input(
          'checks.updated',
          {
            fullName: input.fullName,
            headSha: input.headSha,
            checkRollup: input.checkRollup,
            updatedAt: input.updatedAt,
          },
          { idempotencyKey: `pulls-delivery:${input.deliveryId}` },
        )

      default: {
        const exhaustive: never = input
        throw new Error(`Unhandled webhook kind: ${JSON.stringify(exhaustive)}`)
      }
    }
  },
})

/** Upsert a pull summary (used by GraphQL sync routes). */
export const upsertPull = pullsModule.signal({
  description: 'Upsert a pull request summary from sync or publish.',
  input: Schema.Struct({
    installationId: Schema.Finite,
    fullName: Schema.String,
    number: Schema.Finite,
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
  build: (input) =>
    pullsModule.input(
      'pull.upserted',
      {
        ...input,
        action: 'synced' as const,
      },
      {
        idempotencyKey: `pulls-sync:${input.fullName}#${input.number}@${input.updatedAt}`,
      },
    ),
})

export const recordPublished = pullsModule.signal({
  description: 'Record that a Shuttle session published a pull request.',
  input: Schema.Struct({
    installationId: Schema.Finite,
    fullName: Schema.String,
    number: Schema.Finite,
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
    updatedAt: Schema.Finite,
    isFork: Schema.Boolean,
    runId: Schema.String,
    threadId: Schema.optional(Schema.String),
  }),
  build: (input) => [
    pullsModule.input(
      'pull.upserted',
      {
        installationId: input.installationId,
        fullName: input.fullName,
        number: input.number,
        action: 'opened' as const,
        title: input.title,
        body: input.body,
        url: input.url,
        draft: input.draft,
        author: input.author,
        headRef: input.headRef,
        headSha: input.headSha,
        baseRef: input.baseRef,
        baseSha: input.baseSha,
        additions: input.additions,
        deletions: input.deletions,
        reviewDecision: 'none' as const,
        checkRollup: 'pending' as const,
        updatedAt: input.updatedAt,
        isFork: input.isFork,
        state: 'open' as const,
      },
      { idempotencyKey: `pulls-published:${input.runId}:${input.fullName}#${input.number}` },
    ),
    pullsModule.input(
      'pull.linked',
      {
        fullName: input.fullName,
        number: input.number,
        runId: input.runId,
        role: 'author' as const,
        ...(input.threadId ? { threadId: input.threadId } : {}),
      },
      { idempotencyKey: `pulls-link:${input.runId}:${input.fullName}#${input.number}:author` },
    ),
  ],
})

/** The event that links a session to a pull request as its reviewer. */
export function reviewerLinked(input: {
  readonly fullName: string
  readonly number: number
  readonly runId: string
  readonly threadId?: string
}) {
  return pullsModule.input(
    'pull.linked',
    {
      fullName: input.fullName,
      number: input.number,
      runId: input.runId,
      role: 'reviewer' as const,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    },
    { idempotencyKey: `pulls-link:${input.runId}:${input.fullName}#${input.number}:reviewer` },
  )
}

export const recordReview = pullsModule.signal({
  description: 'Record that a Shuttle session submitted a pull request review.',
  input: Schema.Struct({
    fullName: Schema.String,
    number: Schema.Finite,
    runId: Schema.String,
    threadId: Schema.optional(Schema.String),
    verdict: Schema.Union([
      Schema.Literal('approved'),
      Schema.Literal('changes_requested'),
      Schema.Literal('commented'),
    ]),
    updatedAt: Schema.Finite,
  }),
  build: (input) => [
    pullsModule.input(
      'review.submitted',
      {
        fullName: input.fullName,
        number: input.number,
        verdict: input.verdict,
        updatedAt: input.updatedAt,
      },
      {
        idempotencyKey: `pulls-review:${input.runId}:${input.fullName}#${input.number}:${input.updatedAt}`,
      },
    ),
    reviewerLinked(input),
  ],
})

/**
 * Links a review session to the pull request it reviews as soon as the session starts, so the
 * pull request shows who is reviewing it before any review is submitted.
 */
export const linkReviewSession = pullsModule.signal({
  description: 'Link a review session to the pull request it is reviewing.',
  input: Schema.Struct({
    fullName: Schema.String,
    number: Schema.Finite,
    runId: Schema.String,
  }),
  build: (input) => reviewerLinked(input),
})

export const upsertComment = pullsModule.signal({
  description: 'Record a review comment written or edited on GitHub.',
  input: Schema.Struct({
    fullName: Schema.String,
    number: Schema.Finite,
    comment: PullCommentSchema,
  }),
  build: (input) =>
    pullsModule.input('comment.upserted', input, {
      idempotencyKey: `pulls-comment:${input.comment.commentId}:${input.comment.updatedAt}`,
    }),
})

export const removeComment = pullsModule.signal({
  description: 'Record that a review comment was deleted on GitHub.',
  input: Schema.Struct({
    fullName: Schema.String,
    number: Schema.Finite,
    commentId: Schema.Finite,
  }),
  build: (input) =>
    pullsModule.input('comment.removed', input, {
      idempotencyKey: `pulls-comment-removed:${input.commentId}`,
    }),
})

export const setThreadResolution = pullsModule.signal({
  description: 'Record that a review thread was resolved or reopened on GitHub.',
  input: Schema.Struct({
    fullName: Schema.String,
    number: Schema.Finite,
    rootId: Schema.Finite,
    resolved: Schema.Boolean,
    updatedAt: Schema.Finite,
  }),
  build: (input) =>
    pullsModule.input('thread.resolution', input, {
      idempotencyKey: `pulls-thread:${input.rootId}:${input.resolved}:${input.updatedAt}`,
    }),
})

export const syncThreads = pullsModule.signal({
  description: 'Replace what is known of a pull request’s review threads with a fresh copy.',
  input: Schema.Struct({
    fullName: Schema.String,
    number: Schema.Finite,
    syncedAt: Schema.Finite,
    threads: Schema.Array(
      Schema.Struct({
        rootId: Schema.Finite,
        resolved: Schema.Boolean,
        comments: Schema.Array(PullCommentSchema),
      }),
    ),
  }),
  build: (input) =>
    pullsModule.input('threads.synced', input, {
      idempotencyKey: `pulls-threads-synced:${input.fullName}#${input.number}:${input.syncedAt}`,
    }),
})

export const setRepoPolicy = pullsModule.signal({
  description: 'Set which folders own a repo and their auto-review mode.',
  input: Schema.Struct({
    fullName: Schema.String,
    installationId: Schema.Finite,
    folders: Schema.Array(
      Schema.Struct({
        folderId: Schema.String,
        autoReview: AutoReviewModeSchema,
      }),
    ),
  }),
  build: (input) =>
    pullsModule.input('repo.policy.set', input, {
      idempotencyKey: `pulls-policy:${input.fullName}:${input.folders.map((folder) => `${folder.folderId}:${folder.autoReview}`).join(',')}`,
    }),
})

export const requestReview = pullsModule.signal({
  description: 'Record that an auto-review session was requested for a pull head.',
  input: Schema.Struct({
    fullName: Schema.String,
    number: Schema.Finite,
    headSha: Schema.String,
    folderId: Schema.String,
    runId: Schema.String,
    at: Schema.Finite,
  }),
  build: (input) =>
    pullsModule.input('review.requested', input, {
      idempotencyKey: `pulls-auto-review:${input.fullName}#${input.number}@${input.headSha}`,
    }),
})

export { PullLinkedRoleSchema }

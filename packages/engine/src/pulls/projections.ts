import { Schema } from 'effect'

import {
  AutoReviewModeSchema,
  CheckRollupSchema,
  PullLinkedRoleSchema,
  ReviewDecisionSchema,
  pullKey,
  pullsModule,
} from './scope'
import { retainPulls } from './retention'

const PullAuthorSchema = Schema.Struct({
  login: Schema.String,
  avatarUrl: Schema.String,
})

const LinkedSessionSchema = Schema.Struct({
  runId: Schema.String,
  role: PullLinkedRoleSchema,
  threadId: Schema.optional(Schema.String),
})

type LinkedSession = {
  readonly runId: string
  readonly role: 'author' | 'reviewer'
  readonly threadId?: string
}

/** One link per session and role; a later link may fill in the thread that acted. */
export function withLinkedSession(
  linked: readonly LinkedSession[],
  next: LinkedSession,
): readonly LinkedSession[] {
  const index = linked.findIndex(
    (session) => session.runId === next.runId && session.role === next.role,
  )

  const current = linked[index]

  if (current === undefined) {
    return [...linked, next]
  }

  if (next.threadId === undefined || next.threadId === '' || current.threadId === next.threadId) {
    return linked
  }

  return linked.map((session, position) =>
    position === index ? { ...session, threadId: next.threadId } : session,
  )
}

const PullSummarySchema = Schema.Struct({
  installationId: Schema.Finite,
  fullName: Schema.String,
  number: Schema.Finite,
  title: Schema.String,
  body: Schema.String,
  url: Schema.String,
  state: Schema.Union([Schema.Literal('open'), Schema.Literal('closed')]),
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
  stack: Schema.NullOr(
    Schema.Struct({
      number: Schema.Finite,
      position: Schema.Finite,
      size: Schema.Finite,
    }),
  ),
  linkedSessions: Schema.Array(LinkedSessionSchema),
  reviewingRunId: Schema.NullOr(Schema.String),
})

const RepoPolicySchema = Schema.Struct({
  installationId: Schema.Finite,
  folders: Schema.Array(
    Schema.Struct({
      folderId: Schema.String,
      autoReview: AutoReviewModeSchema,
    }),
  ),
})

export type PullInboxSummary = {
  readonly installationId: number
  readonly fullName: string
  readonly number: number
  readonly title: string
  readonly body: string
  readonly url: string
  readonly state: 'open' | 'closed'
  readonly draft: boolean
  readonly author: { readonly login: string; readonly avatarUrl: string }
  readonly headRef: string
  readonly headSha: string
  readonly baseRef: string
  readonly baseSha: string
  readonly additions: number
  readonly deletions: number
  readonly reviewDecision: 'approved' | 'changes_requested' | 'review_required' | 'none'
  readonly checkRollup: 'passing' | 'failing' | 'pending' | 'neutral'
  readonly updatedAt: number
  readonly isFork: boolean
  readonly stack: {
    readonly number: number
    readonly position: number
    readonly size: number
  } | null
  readonly linkedSessions: readonly LinkedSession[]
  readonly reviewingRunId: string | null
}

export type PullInboxState = {
  readonly pulls: Readonly<Record<string, PullInboxSummary>>
  readonly policies: Readonly<
    Record<
      string,
      {
        readonly installationId: number
        readonly folders: readonly {
          readonly folderId: string
          readonly autoReview: 'off' | 'others' | 'all'
        }[]
      }
    >
  >
}

export const PullInboxStateSchema = Schema.Struct({
  pulls: Schema.Record(Schema.String, PullSummarySchema),
  policies: Schema.Record(Schema.String, RepoPolicySchema),
})

export const pullInbox = pullsModule.projection({
  name: 'pullInbox',
  shape: PullInboxStateSchema,
  initialState: { pulls: {}, policies: {} } satisfies PullInboxState,
  reduce(state, event): PullInboxState {
    if (event.type === 'pulls.pull.upserted') {
      const key = pullKey(event.payload.fullName, event.payload.number)
      const existing = state.pulls[key]

      if (existing && existing.updatedAt > event.payload.updatedAt) {
        return state
      }

      return {
        ...state,
        pulls: retainPulls({
          ...state.pulls,
          [key]: {
            installationId: event.payload.installationId,
            fullName: event.payload.fullName,
            number: event.payload.number,
            title: event.payload.title,
            body: event.payload.body,
            url: event.payload.url,
            state: event.payload.state,
            draft: event.payload.draft,
            author: event.payload.author,
            headRef: event.payload.headRef,
            headSha: event.payload.headSha,
            baseRef: event.payload.baseRef,
            baseSha: event.payload.baseSha,
            additions: event.payload.additions,
            deletions: event.payload.deletions,
            reviewDecision: event.payload.reviewDecision,
            checkRollup: event.payload.checkRollup,
            updatedAt: event.payload.updatedAt,
            isFork: event.payload.isFork,
            stack: event.payload.stack ?? existing?.stack ?? null,
            linkedSessions: existing?.linkedSessions ?? [],
            reviewingRunId: existing?.reviewingRunId ?? null,
          },
        }),
      }
    }

    if (event.type === 'pulls.pull.closed') {
      const key = pullKey(event.payload.fullName, event.payload.number)
      const existing = state.pulls[key]

      if (!existing) {
        return state
      }

      return {
        ...state,
        pulls: retainPulls({
          ...state.pulls,
          [key]: {
            ...existing,
            state: 'closed',
            updatedAt: Math.max(existing.updatedAt, event.payload.updatedAt),
            reviewingRunId: null,
          },
        }),
      }
    }

    if (event.type === 'pulls.checks.updated') {
      let changed = false
      const pulls = { ...state.pulls }

      for (const [key, pull] of Object.entries(state.pulls)) {
        if (pull.fullName !== event.payload.fullName || pull.headSha !== event.payload.headSha) {
          continue
        }

        pulls[key] = {
          ...pull,
          checkRollup: event.payload.checkRollup,
          updatedAt: Math.max(pull.updatedAt, event.payload.updatedAt),
        }

        changed = true
      }

      return changed ? { ...state, pulls } : state
    }

    if (event.type === 'pulls.review.submitted') {
      const key = pullKey(event.payload.fullName, event.payload.number)
      const existing = state.pulls[key]

      if (!existing) {
        return state
      }

      let reviewDecision = existing.reviewDecision

      switch (event.payload.verdict) {
        case 'approved':
          reviewDecision = 'approved'
          break
        case 'changes_requested':
          reviewDecision = 'changes_requested'
          break
        case 'commented':
          break

        default: {
          const exhaustive: never = event.payload.verdict
          void exhaustive
          break
        }
      }

      return {
        ...state,
        pulls: {
          ...state.pulls,
          [key]: {
            ...existing,
            reviewDecision,
            updatedAt: Math.max(existing.updatedAt, event.payload.updatedAt),
          },
        },
      }
    }

    if (event.type === 'pulls.pull.linked') {
      const key = pullKey(event.payload.fullName, event.payload.number)
      const existing = state.pulls[key]

      if (!existing) {
        return state
      }

      const { threadId } = event.payload
      const base = { runId: event.payload.runId, role: event.payload.role }

      const linkedSessions = withLinkedSession(
        existing.linkedSessions,
        threadId === undefined || threadId === '' ? base : { ...base, threadId },
      )

      if (linkedSessions === existing.linkedSessions) {
        return state
      }

      return {
        ...state,
        pulls: { ...state.pulls, [key]: { ...existing, linkedSessions } },
      }
    }

    if (event.type === 'pulls.repo.policy.set') {
      return {
        ...state,
        policies: {
          ...state.policies,
          [event.payload.fullName]: {
            installationId: event.payload.installationId,
            folders: event.payload.folders,
          },
        },
      }
    }

    if (event.type === 'pulls.review.requested') {
      const key = pullKey(event.payload.fullName, event.payload.number)
      const existing = state.pulls[key]

      if (!existing) {
        return state
      }

      return {
        ...state,
        pulls: {
          ...state.pulls,
          [key]: {
            ...existing,
            reviewingRunId: event.payload.runId,
          },
        },
      }
    }

    return state
  },
})

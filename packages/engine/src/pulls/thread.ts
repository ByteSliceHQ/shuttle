import { Predicate } from 'effect'

import { orgOfRun, scopedRunId } from '@shuttle/api'
import {
  createWaitId,
  emit,
  invoke,
  wait,
  type RuntimeEffect,
  type ThreadDefinition,
} from '@swirls/looms/core'

import { retainPulls } from './retention'
import { pullKey, pullsModule, type AutoReviewMode, type PullLinkedRole } from './scope'

export interface PullRecord {
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
  readonly linkedSessions: readonly { readonly runId: string; readonly role: PullLinkedRole }[]
  readonly reviewingRunId: string | null
  readonly reviewedHeadShas: readonly string[]
}

export interface RepoPolicy {
  readonly installationId: number
  readonly folders: readonly { readonly folderId: string; readonly autoReview: AutoReviewMode }[]
}

export interface PullsState {
  readonly title: string
  readonly pulls: Readonly<Record<string, PullRecord>>
  readonly policies: Readonly<Record<string, RepoPolicy>>
  /** Pending auto-review launches: key = fullName#number@headSha */
  readonly pendingAutoReviews: readonly {
    readonly key: string
    readonly fullName: string
    readonly number: number
    readonly headSha: string
    readonly folderId: string
    readonly installationId: number
    readonly baseSha: string
    readonly baseRef: string
  }[]
}

function shouldAutoReview(
  pull: PullRecord,
  policy: RepoPolicy | undefined,
): { folderId: string } | null {
  if (!policy || pull.state !== 'open' || pull.draft) {
    return null
  }

  if (pull.reviewedHeadShas.includes(pull.headSha)) {
    return null
  }

  const authoredByShuttle = pull.linkedSessions.some((session) => session.role === 'author')

  for (const folder of policy.folders) {
    switch (folder.autoReview) {
      case 'off':
        continue
      case 'others':
        if (authoredByShuttle) {
          continue
        }

        return { folderId: folder.folderId }
      case 'all':
        return { folderId: folder.folderId }

      default: {
        const exhaustive: never = folder.autoReview
        void exhaustive
        continue
      }
    }
  }

  return null
}

export function createPullsThread(): ThreadDefinition<PullsState> {
  return pullsModule.thread<PullsState>({
    kind: 'shuttle-pulls',
    initialState: (ctx) => {
      const input = Predicate.isObject(ctx.input) ? ctx.input : {}
      return {
        title: Predicate.isString(input.title) ? input.title : 'Shuttle pulls',
        pulls: {},
        policies: {},
        pendingAutoReviews: [],
      }
    },
    step(state, event) {
      if (event.type === 'pulls.pull.upserted') {
        const key = pullKey(event.payload.fullName, event.payload.number)
        const existing = state.pulls[key]

        if (existing && existing.updatedAt > event.payload.updatedAt) {
          return state
        }

        // Ignore repos with no policy (not linked to any folder).
        if (!state.policies[event.payload.fullName] && event.payload.action !== 'synced') {
          // Still accept publish/sync upserts that arrive before policy, but skip auto-review.
        }

        const pull: PullRecord = {
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
          reviewedHeadShas: existing?.reviewedHeadShas ?? [],
        }

        let pendingAutoReviews = state.pendingAutoReviews
        const autoActions = new Set(['opened', 'ready_for_review', 'synchronize'])

        if (autoActions.has(event.payload.action)) {
          const target = shouldAutoReview(pull, state.policies[pull.fullName])
          const autoKey = `${key}@${pull.headSha}`

          if (
            target &&
            !pendingAutoReviews.some((item) => item.key === autoKey) &&
            !pull.reviewedHeadShas.includes(pull.headSha)
          ) {
            pendingAutoReviews = [
              ...pendingAutoReviews,
              {
                key: autoKey,
                fullName: pull.fullName,
                number: pull.number,
                headSha: pull.headSha,
                folderId: target.folderId,
                installationId: pull.installationId,
                baseSha: pull.baseSha,
                baseRef: pull.baseRef,
              },
            ]
          }
        }

        return {
          ...state,
          pulls: retainPulls({ ...state.pulls, [key]: pull }),
          pendingAutoReviews,
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
          pendingAutoReviews: state.pendingAutoReviews.filter(
            (item) => !(item.fullName === existing.fullName && item.number === existing.number),
          ),
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

        if (
          existing.linkedSessions.some(
            (session) =>
              session.runId === event.payload.runId && session.role === event.payload.role,
          )
        ) {
          return state
        }

        return {
          ...state,
          pulls: {
            ...state.pulls,
            [key]: {
              ...existing,
              linkedSessions: [
                ...existing.linkedSessions,
                { runId: event.payload.runId, role: event.payload.role },
              ],
            },
          },
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
        const autoKey = `${key}@${event.payload.headSha}`

        return {
          ...state,
          pulls: existing
            ? {
                ...state.pulls,
                [key]: {
                  ...existing,
                  reviewingRunId: event.payload.runId,
                  reviewedHeadShas: existing.reviewedHeadShas.includes(event.payload.headSha)
                    ? existing.reviewedHeadShas
                    : [...existing.reviewedHeadShas, event.payload.headSha],
                },
              }
            : state.pulls,
          pendingAutoReviews: state.pendingAutoReviews.filter((item) => item.key !== autoKey),
        }
      }

      return state
    },
    effects(state, ctx) {
      const effects: RuntimeEffect[] = []

      for (const pending of state.pendingAutoReviews) {
        // The review session lives in the same organization as this pulls run.
        const runId = scopedRunId(
          orgOfRun(ctx.runId),
          `review-${pending.fullName.replace('/', '-')}-${pending.number}-${pending.headSha.slice(0, 8)}`,
        )

        effects.push(
          emit(
            pullsModule.input('review.requested', {
              fullName: pending.fullName,
              number: pending.number,
              headSha: pending.headSha,
              folderId: pending.folderId,
              runId,
              at: Date.now(),
            }),
            `auto_review_${pending.key}`,
          ),
          invoke(
            'pulls.launchReviewSession',
            {
              runId,
              folderId: pending.folderId,
              fullName: pending.fullName,
              number: pending.number,
              headSha: pending.headSha,
              baseSha: pending.baseSha,
            },
            `launch_review_${pending.key}`,
          ),
        )
      }

      effects.push(
        wait({
          waitId: createWaitId(ctx.threadId, 'pulls_mailbox'),
          on: {
            type: [
              'pulls.pull.upserted',
              'pulls.pull.closed',
              'pulls.checks.updated',
              'pulls.review.submitted',
              'pulls.pull.linked',
              'pulls.comment.upserted',
              'pulls.comment.removed',
              'pulls.thread.resolution',
              'pulls.threads.synced',
              'pulls.repo.policy.set',
              'pulls.review.requested',
            ],
          },
          tag: { kind: 'pulls-mailbox' },
        }),
      )

      return effects
    },
  })
}

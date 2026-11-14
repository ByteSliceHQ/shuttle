import { defineProjection } from '@swirls/looms/core'

import type { PublishedPull, PullStackPosition } from './session-feed'
import type { PullsEvent } from './shuttle-events'
import { useTenant } from './tenant'

export type AutoReviewMode = 'off' | 'others' | 'all'
export type ReviewDecision = 'approved' | 'changes_requested' | 'review_required' | 'none'
export type CheckRollup = 'passing' | 'failing' | 'pending' | 'neutral'

export interface PullInboxSummary {
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
  readonly reviewDecision: ReviewDecision
  readonly checkRollup: CheckRollup
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

export interface LinkedSession {
  readonly runId: string
  readonly role: 'author' | 'reviewer'
  /** Agent thread inside the session that opened or reviewed the PR. */
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

  if (index === -1) {
    return [...linked, next]
  }

  const current = linked[index]!

  if (!next.threadId || current.threadId === next.threadId) {
    return linked
  }

  return linked.map((session, position) =>
    position === index ? { ...session, threadId: next.threadId } : session,
  )
}

export interface PullInboxState {
  readonly pulls: Readonly<Record<string, PullInboxSummary>>
  readonly policies: Readonly<
    Record<
      string,
      {
        readonly installationId: number
        readonly folders: readonly {
          readonly folderId: string
          readonly autoReview: AutoReviewMode
        }[]
      }
    >
  >
}

export const emptyPullInbox: PullInboxState = { pulls: {}, policies: {} }

export function pullKey(fullName: string, number: number): string {
  return `${fullName}#${number}`
}

export const pullInbox = defineProjection<PullInboxState, PullsEvent>({
  name: 'pullInbox',
  initialState: emptyPullInbox,
  reduce(state, event): PullInboxState {
    switch (event.type) {
      case 'pulls.pull.upserted': {
        const payload = event.payload
        const key = pullKey(payload.fullName, payload.number)
        const existing = state.pulls[key]

        if (existing && existing.updatedAt > payload.updatedAt) {
          return state
        }

        return {
          ...state,
          pulls: {
            ...state.pulls,
            [key]: {
              ...payload,
              stack: payload.stack ?? null,
              linkedSessions: existing?.linkedSessions ?? [],
              reviewingRunId: existing?.reviewingRunId ?? null,
            },
          },
        }
      }

      case 'pulls.pull.closed': {
        const payload = event.payload
        const key = pullKey(payload.fullName, payload.number)
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
              state: 'closed',
              updatedAt: Math.max(existing.updatedAt, payload.updatedAt),
              reviewingRunId: null,
            },
          },
        }
      }

      case 'pulls.checks.updated': {
        const payload = event.payload

        let changed = false
        const pulls = { ...state.pulls }

        for (const [key, pull] of Object.entries(state.pulls)) {
          if (pull.fullName !== payload.fullName || pull.headSha !== payload.headSha) {
            continue
          }

          pulls[key] = {
            ...pull,
            checkRollup: payload.checkRollup,
            updatedAt: Math.max(pull.updatedAt, payload.updatedAt),
          }

          changed = true
        }

        return changed ? { ...state, pulls } : state
      }

      case 'pulls.review.submitted': {
        const payload = event.payload

        const key = pullKey(payload.fullName, payload.number)
        const existing = state.pulls[key]

        if (!existing) {
          return state
        }

        let reviewDecision = existing.reviewDecision

        switch (payload.verdict) {
          case 'approved':
            reviewDecision = 'approved'
            break
          case 'changes_requested':
            reviewDecision = 'changes_requested'
            break
          case 'commented':
            break

          default: {
            const exhaustive: never = payload.verdict
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
              updatedAt: Math.max(existing.updatedAt, payload.updatedAt),
            },
          },
        }
      }

      case 'pulls.pull.linked': {
        const payload = event.payload

        const key = pullKey(payload.fullName, payload.number)
        const existing = state.pulls[key]

        if (!existing) {
          return state
        }

        const linkedSessions = withLinkedSession(existing.linkedSessions, {
          runId: payload.runId,
          role: payload.role,
          ...(payload.threadId ? { threadId: payload.threadId } : {}),
        })

        if (linkedSessions === existing.linkedSessions) {
          return state
        }

        return {
          ...state,
          pulls: { ...state.pulls, [key]: { ...existing, linkedSessions } },
        }
      }

      case 'pulls.repo.policy.set': {
        const payload = event.payload

        return {
          ...state,
          policies: {
            ...state.policies,
            [payload.fullName]: {
              installationId: payload.installationId,
              folders: payload.folders,
            },
          },
        }
      }

      case 'pulls.review.requested': {
        const payload = event.payload

        const key = pullKey(payload.fullName, payload.number)
        const existing = state.pulls[key]

        if (!existing) {
          return state
        }

        return {
          ...state,
          pulls: {
            ...state.pulls,
            [key]: { ...existing, reviewingRunId: payload.runId },
          },
        }
      }

      default:
        return state
    }
  },
})

export type PullLaneId =
  | 'needs_review'
  | 'reviewing'
  | 'changes_requested'
  | 'ready'
  | 'drafts'
  | 'opened_by_shuttle'

export function laneForPull(pull: PullInboxSummary): PullLaneId {
  if (pull.reviewingRunId) {
    return 'reviewing'
  }

  if (pull.draft) {
    return 'drafts'
  }

  if (pull.reviewDecision === 'changes_requested') {
    return 'changes_requested'
  }

  if (pull.reviewDecision === 'approved' && pull.checkRollup === 'passing') {
    return 'ready'
  }

  if (pull.linkedSessions.some((session) => session.role === 'author')) {
    return 'opened_by_shuttle'
  }

  return 'needs_review'
}

export const PULL_LANES: { id: PullLaneId; label: string }[] = [
  { id: 'needs_review', label: 'Needs review' },
  { id: 'reviewing', label: 'Shuttle is reviewing' },
  { id: 'changes_requested', label: 'Changes requested' },
  { id: 'ready', label: 'Ready to ship' },
  { id: 'drafts', label: 'Drafts' },
  { id: 'opened_by_shuttle', label: 'Opened by Shuttle' },
]

export type InboxEntry =
  | { readonly kind: 'pull'; readonly pull: PullInboxSummary }
  | {
      readonly kind: 'changeset'
      readonly sessionRunId: string
      readonly pulls: readonly PullInboxSummary[]
      /** Open PRs from this session across every lane. */
      readonly total: number
    }
  | {
      readonly kind: 'stack'
      readonly stack: PullStack
      /** Layers that belong in this lane (others render as ghost rows). */
      readonly lanePulls: readonly PullInboxSummary[]
    }

export interface PullStack {
  readonly key: string
  readonly fullName: string
  readonly native: boolean
  readonly number: number | null
  readonly baseRef: string
  /** Bottom → top order. */
  readonly layers: readonly PullInboxSummary[]
}

/**
 * Native GitHub stacks first (by stack.number), then chained baseRef→headRef
 * groups that are not already in a native stack.
 */
export function stacksOf(pulls: readonly PullInboxSummary[]): readonly PullStack[] {
  const open = pulls.filter((pull) => pull.state === 'open')
  const stacks: PullStack[] = []
  const claimed = new Set<string>()

  const byNative = new Map<string, PullInboxSummary[]>()

  for (const pull of open) {
    if (!pull.stack) {
      continue
    }

    const key = `${pull.fullName}:native:${pull.stack.number}`
    byNative.set(key, [...(byNative.get(key) ?? []), pull])
  }

  for (const [key, layers] of byNative) {
    const ordered = [...layers].toSorted(
      (a, b) => (a.stack?.position ?? 0) - (b.stack?.position ?? 0),
    )

    if (ordered.length < 2) {
      continue
    }

    for (const layer of ordered) {
      claimed.add(pullKey(layer.fullName, layer.number))
    }

    const first = ordered[0]!

    stacks.push({
      key,
      fullName: first.fullName,
      native: true,
      number: first.stack?.number ?? null,
      baseRef: ordered[0]?.baseRef ?? 'main',
      layers: ordered,
    })
  }

  // Fallback: chain detection by baseRef === another open PR's headRef.
  const byRepo = new Map<string, PullInboxSummary[]>()

  for (const pull of open) {
    if (claimed.has(pullKey(pull.fullName, pull.number))) {
      continue
    }

    byRepo.set(pull.fullName, [...(byRepo.get(pull.fullName) ?? []), pull])
  }

  for (const [fullName, repoPulls] of byRepo) {
    const byHead = new Map(repoPulls.map((pull) => [pull.headRef, pull]))
    const children = new Map<string, PullInboxSummary[]>()

    for (const pull of repoPulls) {
      if (!byHead.has(pull.baseRef)) {
        continue
      }

      children.set(pull.baseRef, [...(children.get(pull.baseRef) ?? []), pull])
    }

    // Roots: open PRs that others stack on, whose base is not another open PR.
    const roots = repoPulls.filter(
      (pull) =>
        !claimed.has(pullKey(pull.fullName, pull.number)) &&
        children.has(pull.headRef) &&
        !byHead.has(pull.baseRef),
    )

    for (const root of roots) {
      const chain: PullInboxSummary[] = [root]
      let tip = root

      while (true) {
        const next = children.get(tip.headRef)?.[0]

        if (!next || claimed.has(pullKey(next.fullName, next.number))) {
          break
        }

        chain.push(next)
        tip = next
      }

      if (chain.length < 2) {
        continue
      }

      for (const layer of chain) {
        claimed.add(pullKey(layer.fullName, layer.number))
      }

      stacks.push({
        key: `${fullName}:chain:${chain.map((layer) => layer.number).join('-')}`,
        fullName,
        native: false,
        number: null,
        baseRef: chain[0]!.baseRef,
        layers: chain,
      })
    }
  }

  return stacks
}

export function authorRunId(pull: PullInboxSummary): string | undefined {
  return pull.linkedSessions.find((session) => session.role === 'author')?.runId
}

/**
 * Prefer stack groups over changeset groups. PRs one Shuttle session opened
 * that are not stacked still travel together as a changeset. Siblings can
 * diverge across lanes, so each lane groups its own share.
 */
export function groupPullsByLane(
  pulls: readonly PullInboxSummary[],
): Map<PullLaneId, InboxEntry[]> {
  const lanes = new Map<PullLaneId, InboxEntry[]>(PULL_LANES.map((lane) => [lane.id, []]))
  const stacks = stacksOf(pulls)

  const inStack = new Set(
    stacks.flatMap((stack) => stack.layers.map((layer) => pullKey(layer.fullName, layer.number))),
  )

  const placedStacks = new Set<string>()

  for (const stack of stacks) {
    for (const layer of stack.layers) {
      const lane = laneForPull(layer)
      const placeKey = `${lane}:${stack.key}`

      if (placedStacks.has(placeKey)) {
        continue
      }

      placedStacks.add(placeKey)

      lanes.get(lane)?.push({
        kind: 'stack',
        stack,
        lanePulls: stack.layers.filter((entry) => laneForPull(entry) === lane),
      })
    }
  }

  const remaining = pulls.filter((pull) => !inStack.has(pullKey(pull.fullName, pull.number)))
  const totals = new Map<string, number>()
  const byLaneSession = new Map<string, PullInboxSummary[]>()

  for (const pull of remaining) {
    const runId = authorRunId(pull)

    if (runId) {
      totals.set(runId, (totals.get(runId) ?? 0) + 1)

      const key = `${laneForPull(pull)}:${runId}`
      byLaneSession.set(key, [...(byLaneSession.get(key) ?? []), pull])
    }
  }

  const placed = new Set<string>()

  for (const pull of remaining) {
    const lane = laneForPull(pull)
    const runId = authorRunId(pull)
    const key = `${lane}:${runId}`
    const group = runId ? byLaneSession.get(key) : undefined

    if (!runId || !group || group.length < 2) {
      lanes.get(lane)?.push({ kind: 'pull', pull })
      continue
    }

    if (!placed.has(key)) {
      placed.add(key)

      lanes.get(lane)?.push({
        kind: 'changeset',
        sessionRunId: runId,
        pulls: group,
        total: totals.get(runId) ?? group.length,
      })
    }
  }

  return lanes
}

export function pullsForFolder(
  inbox: PullInboxState,
  fullNames: readonly string[],
): PullInboxSummary[] {
  const allowed = new Set(fullNames)
  return Object.values(inbox.pulls)
    .filter((pull) => allowed.has(pull.fullName) && pull.state === 'open')
    .toSorted((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Stack position from a Shuttle head branch: `shuttle/<run>/<repo>` is stack 1
 * layer 1, `shuttle/<run>-stack<s?>/<repo>/<n>` is stack s (default 1) layer n.
 */
export function shuttleStackPosition(headRef: string): PullStackPosition | undefined {
  const layered = /^shuttle\/[^/]+-stack([1-9]\d*)?\/[^/]+\/([1-9]\d*)$/.exec(headRef)

  if (layered) {
    return { id: layered[1] ? Number(layered[1]) : 1, layer: Number(layered[2]) }
  }

  return /^shuttle\/[^/]+\/[^/]+$/.test(headRef) ? { id: 1, layer: 1 } : undefined
}

/** The pull request this session is reviewing, if it is a review session. */
export function reviewedPullForSession(
  inbox: PullInboxState,
  runId: string,
): PullInboxSummary | undefined {
  return Object.values(inbox.pulls).find((pull) =>
    pull.linkedSessions.some((session) => session.runId === runId && session.role === 'reviewer'),
  )
}

/**
 * The pull request a session's review tab is about: the one it is reviewing, or else the one it
 * opened, so the people who wrote a change see what is said about it where they are working.
 * A session that opened several shows the one touched most recently.
 */
export function pullOfSession(inbox: PullInboxState, runId: string): PullInboxSummary | undefined {
  return (
    reviewedPullForSession(inbox, runId) ??
    Object.values(inbox.pulls)
      .filter(
        (pull) =>
          pull.state === 'open' &&
          pull.linkedSessions.some(
            (session) => session.runId === runId && session.role === 'author',
          ),
      )
      .toSorted((a, b) => b.updatedAt - a.updatedAt)[0]
  )
}

/** Open pulls this session authored, with the proposing thread when known. */
export function authoredPullsForSession(inbox: PullInboxState, runId: string): PublishedPull[] {
  return Object.values(inbox.pulls)
    .filter(
      (pull) =>
        pull.state === 'open' &&
        pull.linkedSessions.some((session) => session.runId === runId && session.role === 'author'),
    )
    .toSorted((a, b) => b.updatedAt - a.updatedAt)
    .map((pull) => {
      const author = pull.linkedSessions.find(
        (session) => session.runId === runId && session.role === 'author',
      )

      const stack = shuttleStackPosition(pull.headRef)

      return {
        fullName: pull.fullName,
        number: pull.number,
        url: pull.url,
        draft: pull.draft,
        ...(author?.threadId ? { threadId: author.threadId } : {}),
        ...(stack ? { stack } : {}),
      }
    })
}

/** Open PR count per authoring session run id. */
export function authoredPullCounts(inbox: PullInboxState): ReadonlyMap<string, number> {
  const counts = new Map<string, number>()

  for (const pull of Object.values(inbox.pulls)) {
    if (pull.state !== 'open') {
      continue
    }

    for (const runId of new Set(
      pull.linkedSessions.flatMap((session) => (session.role === 'author' ? [session.runId] : [])),
    )) {
      counts.set(runId, (counts.get(runId) ?? 0) + 1)
    }
  }

  return counts
}

export function attentionPullCount(pulls: readonly PullInboxSummary[]): number {
  return pulls.filter((pull) => {
    const lane = laneForPull(pull)
    return lane === 'needs_review' || lane === 'changes_requested'
  }).length
}

export type RepoSyncStatus = 'ok' | 'forbidden' | 'failed'

export interface RepoSyncReport {
  readonly fullName: string
  readonly status: RepoSyncStatus
  readonly open: number
  readonly synced: number
  readonly checksHidden: boolean
  readonly message: string | null
}

export interface InstallationAccessReport {
  readonly installationId: number
  readonly account: string
  readonly missingPermissions: readonly string[]
  readonly settingsUrl: string
}

export interface FolderSyncReport {
  readonly folderId: string
  readonly upserted: number
  readonly repos: readonly RepoSyncReport[]
  readonly installations: readonly InstallationAccessReport[]
}

export async function syncFolderPulls(folderId: string): Promise<FolderSyncReport> {
  const response = await fetch(`/workspace/folders/${encodeURIComponent(folderId)}/pulls/sync`, {
    method: 'POST',
  })

  if (!response.ok) {
    throw new Error(`Failed to sync pulls: ${response.status}`)
  }

  return (await response.json()) as FolderSyncReport
}

export async function startPullReview(
  folderId: string,
  fullName: string,
  number: number,
  input: { headSha: string; baseSha: string; title?: string },
): Promise<{ runId: string }> {
  const response = await fetch(
    `/workspace/folders/${encodeURIComponent(folderId)}/pulls/${encodeURIComponent(fullName)}/${number}/review`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    },
  )

  if (!response.ok) {
    throw new Error(`Failed to start review: ${response.status}`)
  }

  return (await response.json()) as { runId: string }
}

/** The pulls run of the organization the browser is signed in to. */
export function usePullsRunId(): string {
  return useTenant().runs.pulls
}

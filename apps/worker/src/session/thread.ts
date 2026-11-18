import { Predicate } from 'effect'

import {
  createWaitId,
  deterministicThreadId,
  emit,
  invoke,
  launch,
  spawn,
  wait,
  asJson,
  type EventEnvelope,
  type JsonValue,
  type RuntimeEffect,
  type ThreadDefinition,
  isJsonObject,
} from '@swirls/looms/core'

import { AttachmentInputSchema } from '../agents/attachment-input'
import { isHardStop } from '../agents/intake'
import { withAttachmentManifest } from '../assets/sandbox'
import { reflectionRunId } from '../tenancy/run-id'
import {
  buildConductorInput,
  conductorChildThreadId,
  conductorEndReason,
  initialConductor,
  liveConductorThreadId,
  markConductorDown,
  markConductorLive,
  queueForConductor,
  shouldSpawnConductor,
  spawnReason,
  type ConductorState,
  queuedAttachments,
} from './conductor'
import type { JsonObjectBuilder } from './json-object'
import { appendPrPublishEffects, withPrApprovalDecision } from './publish-effects'
import { routeForEffects } from './route-effects'
import { shuttleModule, type AttachmentRef, type MessageAuthor } from './scope'
import {
  withPrProposal,
  withPrPublishSettled,
  withStackPublished,
  type PendingPrPublish,
  type SessionRepoStack,
} from './stack-state'

export type { SessionRepoStack, SessionStackLayer, SessionStackNative } from './stack-state'

export type InterjectionKind = 'question' | 'idea' | 'constraint' | 'correction' | 'task' | 'stop'

export interface PendingMessage {
  readonly messageId: string
  readonly text: string
  readonly forceKind?: InterjectionKind
  readonly targetThreadId?: string
  readonly author?: MessageAuthor
  readonly attachments?: readonly AttachmentRef[]
}

export interface ActiveIntake {
  readonly messageId: string
  readonly childThreadId: string
  readonly text: string
  readonly forceKind?: InterjectionKind
  readonly targetThreadId?: string
  readonly author?: MessageAuthor
  readonly attachments?: readonly AttachmentRef[]
}

export interface PendingRoute {
  readonly messageId: string
  readonly kind: InterjectionKind
  readonly targetThreadId: string | null
  readonly text: string
  readonly author?: MessageAuthor
  readonly attachments?: readonly AttachmentRef[]
}

export interface LinkedSessionRepo {
  readonly installationId: number
  readonly owner: string
  readonly name: string
  readonly fullName: string
  readonly defaultBranch: string
  readonly private: boolean
}

export interface SessionPullRef {
  readonly fullName: string
  readonly number: number
  readonly headSha: string
  readonly baseSha: string
}

export interface SessionState {
  /**
   * Everyone who has spoken in the session, starting with the person who began it. Once there
   * is more than one, agents are told who each message is from.
   */
  readonly speakerIds: readonly string[]
  readonly initialAttachments?: readonly AttachmentRef[]
  readonly goal: string
  readonly repoUrl: string | null
  readonly folderId: string | null
  readonly workspaceRunId: string | null
  readonly sandboxName: string | null
  readonly repos: readonly LinkedSessionRepo[]
  readonly lessons: readonly { id: string; text: string; scope?: string }[]
  readonly playbookVersion: number
  readonly playbookRunId: string | null
  readonly conductor: ConductorState
  readonly briefVersion: number
  readonly briefText: string
  readonly pendingMessages: readonly PendingMessage[]
  readonly activeIntake: ActiveIntake | null
  readonly pendingRoute: PendingRoute | null
  readonly activeNarrators: readonly string[]
  readonly workerThreadIds: readonly string[]
  readonly processedMessageIds: readonly string[]
  readonly reflectionLaunched: boolean
  readonly sandboxBound: boolean
  readonly parked: boolean
  /** Bumped whenever the mailbox wait settles so Looms will re-arm it. */
  readonly mailboxEpoch: number
  readonly pull: SessionPullRef | null
  readonly reviewerSpawned: boolean
  /** Pending PR publish waiting for approval or effect completion. */
  readonly pendingPrPublish: PendingPrPublish | null
  /** Per-repo stack of published layers (local branch ↔ remote PR). */
  readonly stacks: Readonly<Record<string, SessionRepoStack>>
  /** Rejected publish gate whose `pr.discarded` settles the proposing tool call. */
  readonly discardedPrApprovalId: string | null
  /**
   * A pull request asked for from the session's PR button, until its publish gate opens. Absent
   * in sessions from before the button.
   */
  readonly pendingPrRequest?: {
    readonly approvalId: string
    readonly title: string
    readonly body: string
    readonly draft: boolean
    readonly repo: string | null
  } | null
  readonly pendingReviewSubmit: {
    readonly approvalId: string
    readonly fullName: string
    readonly number: number
    readonly commitId: string
    readonly summary: string
    readonly verdict: 'approve' | 'request_changes' | 'comment'
    readonly comments: readonly {
      readonly path: string
      readonly line: number
      readonly side: 'LEFT' | 'RIGHT'
      readonly body: string
    }[]
    readonly status: 'awaiting_approval' | 'submitting'
  } | null
}

function asObject(value: JsonValue | undefined): { [key: string]: JsonValue } {
  return isJsonObject(value) ? value : {}
}

type AuthorAndAttachments = { author?: MessageAuthor; attachments?: readonly AttachmentRef[] }

/** `author` and `attachments`, each only when there is one. */
function withAuthorAndAttachments(
  author: MessageAuthor | undefined,
  attachments: readonly AttachmentRef[] | undefined,
): AuthorAndAttachments {
  const present: AuthorAndAttachments = {}

  if (author !== undefined) {
    present.author = author
  }

  if (attachments !== undefined) {
    present.attachments = attachments
  }

  return present
}

/** True for a string that is neither missing nor empty. */
function isPresent(value: string | undefined | null): value is string {
  return value !== undefined && value !== null && value !== ''
}

/** The first line of `text`, kept short enough for a pull request title. */
function firstLine(text: string): string {
  const line = text.trim().split('\n')[0]?.trim() ?? ''

  return line.length > 72 ? `${line.slice(0, 71).trimEnd()}…` : line
}

/** Once a requested pull request's gate is open, the request is done. */
function settlePrRequest(state: SessionState, approvalId: JsonValue | undefined): SessionState {
  const request = state.pendingPrRequest

  return request !== undefined && request !== null && request.approvalId === approvalId
    ? { ...state, pendingPrRequest: null }
    : state
}

function objectPayload(event: EventEnvelope): { [key: string]: JsonValue } {
  return asObject(event.payload)
}

function asString(value: JsonValue | undefined): string | null {
  return Predicate.isString(value) ? value : null
}

type EventLike = {
  readonly type: string | undefined
  readonly payload: JsonValue | undefined
  readonly threadId: string | undefined
}

/** The checked fields of an event embedded in a wait wake-up, or null when it is not an object. */
function asEventLike(value: JsonValue | undefined): EventLike | null {
  if (!isJsonObject(value)) {
    return null
  }

  const { type, payload, threadId } = value

  return {
    type: Predicate.isString(type) ? type : undefined,
    payload,
    threadId: Predicate.isString(threadId) ? threadId : undefined,
  }
}

function readKind(value: JsonValue | undefined): InterjectionKind | null {
  return value === 'question' ||
    value === 'idea' ||
    value === 'constraint' ||
    value === 'correction' ||
    value === 'task' ||
    value === 'stop'
    ? value
    : null
}

function kindFromEvaluator(event: EventEnvelope, fallback?: InterjectionKind): InterjectionKind {
  const payload = objectPayload(event)
  const embedded = asEventLike(payload.event)
  const embeddedPayload = asObject(embedded?.payload)

  const output = Predicate.isObject(embeddedPayload.output)
    ? asObject(embeddedPayload.output)
    : embeddedPayload

  const route = readKind(output.route)

  if (route !== null) {
    return route
  }

  const answers = asObject(output.answers)
  const kindAnswer = asObject(answers.kind)
  const fromAnswer = readKind(kindAnswer.value)

  if (fromAnswer !== null) {
    return fromAnswer
  }

  return fallback ?? 'task'
}

function bypassIntakeKind(message: PendingMessage): InterjectionKind | null {
  if (message.forceKind !== undefined) {
    return message.forceKind
  }

  return isHardStop(message.text) ? 'stop' : null
}

/** Drop a finished child from workers/narrators, and demote the conductor if it matches. */
function applyChildTerminal(
  state: SessionState,
  threadId: string,
  reason: ReturnType<typeof conductorEndReason>,
): SessionState {
  const conductor = markConductorDown(state.conductor, threadId, reason)
  const demoted = conductor !== state.conductor

  return {
    ...state,
    conductor,
    reflectionLaunched: demoted ? false : state.reflectionLaunched,
    workerThreadIds: state.workerThreadIds.filter((id) => id !== threadId),
    activeNarrators: state.activeNarrators.filter((id) => id !== threadId),
  }
}

export function createSessionThread(): ThreadDefinition<SessionState> {
  return shuttleModule.thread<SessionState>({
    kind: 'shuttle-session',
    initialState: (ctx) => {
      const input = asObject(ctx.input)
      const lessonsRaw = Array.isArray(input.lessons) ? input.lessons : []

      const lessons = lessonsRaw.flatMap((lesson) => {
        const item = asObject(lesson)

        if (!Predicate.isString(item.id) || !Predicate.isString(item.text)) {
          return []
        }

        return [
          {
            id: item.id,
            text: item.text,
            scope: Predicate.isString(item.scope) ? item.scope : undefined,
          },
        ]
      })

      const reposRaw = Array.isArray(input.repos) ? input.repos : []

      const repos = reposRaw.flatMap((repo) => {
        const item = asObject(repo)

        if (
          !Predicate.isNumber(item.installationId) ||
          !Predicate.isString(item.owner) ||
          !Predicate.isString(item.name) ||
          !Predicate.isString(item.fullName) ||
          !Predicate.isString(item.defaultBranch) ||
          !Predicate.isBoolean(item.private)
        ) {
          return []
        }

        return [
          {
            installationId: item.installationId,
            owner: item.owner,
            name: item.name,
            fullName: item.fullName,
            defaultBranch: item.defaultBranch,
            private: item.private,
          },
        ]
      })

      const pullRaw = asObject(input.pull)

      const pull =
        Predicate.isString(pullRaw.fullName) &&
        Predicate.isNumber(pullRaw.number) &&
        Predicate.isString(pullRaw.headSha) &&
        Predicate.isString(pullRaw.baseSha)
          ? {
              fullName: pullRaw.fullName,
              number: pullRaw.number,
              headSha: pullRaw.headSha,
              baseSha: pullRaw.baseSha,
            }
          : null

      const ownerId = asString(input.ownerId)

      return {
        speakerIds: isPresent(ownerId) ? [ownerId] : [],
        initialAttachments: AttachmentInputSchema.array().parse(input.attachments ?? []),
        goal: asString(input.goal) ?? 'Improve the repository',
        repoUrl: asString(input.repoUrl),
        folderId: asString(input.folderId),
        workspaceRunId: asString(input.workspaceRunId),
        sandboxName: asString(input.sandboxName),
        repos,
        lessons,
        playbookVersion: Predicate.isNumber(input.playbookVersion) ? input.playbookVersion : 0,
        playbookRunId: asString(input.playbookRunId),
        conductor: initialConductor(),
        briefVersion: 1,
        briefText: asString(input.goal) ?? 'Improve the repository',
        pendingMessages: [],
        activeIntake: null,
        pendingRoute: null,
        activeNarrators: [],
        workerThreadIds: [],
        processedMessageIds: [],
        reflectionLaunched: false,
        sandboxBound: false,
        pull,
        reviewerSpawned: false,
        pendingPrPublish: null,
        stacks: {},
        discardedPrApprovalId: null,
        pendingReviewSubmit: null,
        pendingPrRequest: null,
        parked: false,
        mailboxEpoch: 0,
      }
    },
    step(state, event) {
      switch (event.type) {
        case 'runtime.thread.started': {
          return state
        }

        case 'shuttle.sandbox.bound': {
          return { ...state, sandboxBound: true }
        }

        case 'shuttle.pr.proposed': {
          return settlePrRequest(
            withPrProposal(state, asObject(asJson(event.payload)), event.threadId ?? null),
            event.payload.approvalId,
          )
        }

        case 'shuttle.pr.requested': {
          // One publish at a time: while a gate is open or publishing, the button asks again later.
          if (state.pendingPrPublish !== null) {
            return state
          }

          return {
            ...state,
            pendingPrRequest: {
              approvalId: `pr_publish_${event.payload.requestId}`,
              title: event.payload.title,
              body: event.payload.body,
              draft: event.payload.draft,
              repo: event.payload.repo ?? null,
            },
          }
        }

        case 'approval.decided': {
          const approvalId = Predicate.isString(event.payload.approvalId)
            ? event.payload.approvalId
            : ''

          const prNext = withPrApprovalDecision(state, event.payload)

          if (prNext) {
            return prNext
          }

          if (approvalId.startsWith('pr_review_')) {
            if (event.payload.outcome !== 'approve') {
              return { ...state, pendingReviewSubmit: null }
            }

            const payload = asObject(event.payload.payload)
            const verdictRaw = Predicate.isString(payload.verdict) ? payload.verdict : 'comment'

            const verdict =
              verdictRaw === 'approve' ||
              verdictRaw === 'request_changes' ||
              verdictRaw === 'comment'
                ? verdictRaw
                : 'comment'

            const commentsRaw = Array.isArray(payload.comments) ? payload.comments : []

            const comments = commentsRaw.flatMap((item) => {
              const comment = asObject(item)

              if (
                !Predicate.isString(comment.path) ||
                !Predicate.isNumber(comment.line) ||
                !Predicate.isString(comment.body)
              ) {
                return []
              }

              const side = comment.side === 'LEFT' ? ('LEFT' as const) : ('RIGHT' as const)
              return [
                {
                  path: comment.path,
                  line: comment.line,
                  side,
                  body: comment.body,
                },
              ]
            })

            const pull = state.pull
            const gateFullName = Predicate.isString(payload.fullName) ? payload.fullName : ''
            const gateNumber = Predicate.isNumber(payload.number) ? payload.number : 0
            const gateCommitId = Predicate.isString(payload.commitId) ? payload.commitId : ''

            return {
              ...state,
              pendingReviewSubmit: {
                approvalId,
                // The session knows which pull request it reviews; what the gate carries is only
                // a fallback for a session that was not started on one.
                fullName: pull !== null && pull.fullName !== '' ? pull.fullName : gateFullName,
                number: pull !== null && pull.number !== 0 ? pull.number : gateNumber,
                commitId: gateCommitId !== '' ? gateCommitId : (pull?.headSha ?? ''),
                summary: Predicate.isString(payload.summary) ? payload.summary : 'Shuttle review',
                verdict,
                comments,
                status: 'submitting',
              },
            }
          }

          return state
        }

        case 'shuttle.pr.published': {
          return withStackPublished(
            withPrPublishSettled(state, event.payload.approvalId),
            asObject(asJson(event.payload)),
          )
        }

        case 'shuttle.pr.publish_failed': {
          return withPrPublishSettled(state, event.payload.approvalId)
        }

        case 'shuttle.review.submitted': {
          return { ...state, pendingReviewSubmit: null }
        }

        case 'shuttle.review.submit_failed': {
          return { ...state, pendingReviewSubmit: null }
        }

        case 'shuttle.playbook.loaded': {
          return {
            ...state,
            playbookVersion: event.payload.version,
            lessons: event.payload.lessons,
          }
        }

        case 'shuttle.conductor.spawned': {
          if (state.pull && !state.reviewerSpawned) {
            return { ...state, reviewerSpawned: true }
          }

          return {
            ...state,
            conductor: markConductorLive(state.conductor, event.payload.childThreadId),
          }
        }

        case 'shuttle.user.said': {
          const payload = event.payload

          if (state.processedMessageIds.includes(payload.messageId)) {
            return state
          }

          const author = payload.author

          return {
            ...state,
            speakerIds:
              author !== undefined && !state.speakerIds.includes(author.id)
                ? [...state.speakerIds, author.id]
                : state.speakerIds,
            pendingMessages: [
              ...state.pendingMessages,
              {
                messageId: payload.messageId,
                text: payload.text,
                forceKind: payload.forceKind,
                targetThreadId: payload.targetThreadId,
                ...withAuthorAndAttachments(
                  author,
                  payload.attachments !== undefined && payload.attachments.length > 0
                    ? payload.attachments
                    : undefined,
                ),
              },
            ],
            processedMessageIds: [...state.processedMessageIds, payload.messageId],
            parked: false,
            // Signals can arrive with no armed mailbox; bump so idle wait can re-register.
            mailboxEpoch: state.mailboxEpoch + 1,
          }
        }

        case 'shuttle.reroute': {
          return {
            ...state,
            pendingRoute: {
              messageId: event.payload.messageId,
              kind: event.payload.kind,
              targetThreadId: event.payload.targetThreadId ?? null,
              text: `Reroute of ${event.payload.messageId}`,
            },
          }
        }

        case 'shuttle.intake.started': {
          const pending = state.pendingMessages.find(
            (message) => message.messageId === event.payload.messageId,
          )

          if (!pending) {
            return state
          }

          return {
            ...state,
            pendingMessages: state.pendingMessages.filter(
              (message) => message.messageId !== event.payload.messageId,
            ),
            activeIntake: {
              messageId: pending.messageId,
              childThreadId: event.payload.childThreadId,
              text: pending.text,
              forceKind: pending.forceKind,
              targetThreadId: pending.targetThreadId,
              ...withAuthorAndAttachments(pending.author, pending.attachments),
            },
          }
        }

        case 'shuttle.intake.bypassed': {
          const payload = event.payload

          const bypassed = state.pendingMessages.find(
            (message) => message.messageId === payload.messageId,
          )

          return {
            ...state,
            pendingMessages: state.pendingMessages.filter(
              (message) => message.messageId !== payload.messageId,
            ),
            pendingRoute: {
              messageId: payload.messageId,
              kind: payload.kind,
              targetThreadId: payload.targetThreadId,
              text: payload.text,
              ...withAuthorAndAttachments(bypassed?.author, bypassed?.attachments),
            },
            mailboxEpoch: state.mailboxEpoch + 1,
          }
        }

        case 'runtime.wait.satisfied': {
          const payload = objectPayload(event)
          const tag = asObject(payload.tag)
          const embedded = asEventLike(payload.event)
          const embeddedPayload = asObject(embedded?.payload)
          // Stable wait ids stay completed forever unless we bump the epoch.
          const base = { ...state, mailboxEpoch: state.mailboxEpoch + 1 }

          if (tag.kind === 'shuttle-intake' && base.activeIntake !== null) {
            const kind = base.activeIntake.forceKind ?? kindFromEvaluator(event, 'task')
            return {
              ...base,
              activeIntake: null,
              pendingRoute: {
                messageId: base.activeIntake.messageId,
                kind,
                targetThreadId: base.activeIntake.targetThreadId ?? null,
                text: base.activeIntake.text,
                ...withAuthorAndAttachments(
                  base.activeIntake.author,
                  base.activeIntake.attachments,
                ),
              },
            }
          }

          if (tag.kind === 'shuttle-narrator' || tag.kind === 'shuttle-worker') {
            const childThreadId = asString(tag.childThreadId)
            return {
              ...base,
              workerThreadIds: base.workerThreadIds.filter((id) => id !== childThreadId),
              activeNarrators: base.activeNarrators.filter((id) => id !== childThreadId),
            }
          }

          if (tag.kind === 'shuttle-conductor') {
            const childThreadId = asString(tag.childThreadId)

            if (!isPresent(childThreadId)) {
              return base
            }

            return applyChildTerminal(base, childThreadId, conductorEndReason(embedded?.type))
          }

          // The conductor's proposal reaches the root only through this mailbox wake, and the
          // embedded copy carries no threadId. Only the conductor can propose PRs.
          if (embedded?.type === 'shuttle.pr.proposed') {
            return settlePrRequest(
              withPrProposal(
                base,
                embeddedPayload,
                embedded.threadId ?? liveConductorThreadId(base.conductor),
              ),
              embeddedPayload.approvalId,
            )
          }

          if (embedded?.type === 'agent.spawn.requested') {
            const definitionName = asString(embeddedPayload.definitionName)
            const childThreadId = asString(embeddedPayload.childThreadId)

            if (
              definitionName === 'worker' &&
              isPresent(childThreadId) &&
              !base.workerThreadIds.includes(childThreadId)
            ) {
              return {
                ...base,
                workerThreadIds: [...base.workerThreadIds, childThreadId],
              }
            }
          }

          if (
            embedded?.type === 'runtime.thread.completed' ||
            embedded?.type === 'runtime.thread.failed' ||
            embedded?.type === 'runtime.thread.cancelled'
          ) {
            const threadId = asString(embeddedPayload.threadId) ?? embedded.threadId

            if (!isPresent(threadId)) {
              return base
            }

            return applyChildTerminal(base, threadId, conductorEndReason(embedded.type))
          }

          return base
        }

        case 'shuttle.routed': {
          const route = state.pendingRoute
          const queued = event.payload.queued === true

          return {
            ...state,
            pendingRoute: null,
            mailboxEpoch: state.mailboxEpoch + 1,
            conductor:
              queued && route !== null
                ? queueForConductor(state.conductor, {
                    messageId: route.messageId,
                    text: route.text,
                    ...withAuthorAndAttachments(route.author, route.attachments),
                  })
                : state.conductor,
          }
        }

        case 'shuttle.brief.amended': {
          return {
            ...state,
            briefVersion: event.payload.version,
            briefText: event.payload.text,
          }
        }

        case 'shuttle.narrator.spawned': {
          return {
            ...state,
            activeNarrators: [...state.activeNarrators, event.payload.childThreadId],
          }
        }

        case 'shuttle.reflection.launched': {
          return { ...state, reflectionLaunched: true }
        }

        case 'agent.context.compacted':
        case 'agent.effects.requested':
        case 'agent.lineage':
        case 'agent.message':
        case 'agent.message.received':
        case 'agent.session.cancel.requested':
        case 'agent.session.message.submitted':
        case 'agent.session.steer.delivered':
        case 'agent.session.turn.closed':
        case 'agent.session.turn.started':
        case 'agent.spawn.requested':
        case 'agent.steered':
        case 'agent.tool.result':
        case 'agent.tool_call.requested':
        case 'agent.turn.settled':
        case 'agent.turn.started':
        case 'agent.turn.stopped':
        case 'agent.turn.text_delta':
        case 'agent.turn.usage':
        case 'approval.requested':
        case 'approval.timed_out':
        case 'evaluator.evaluated':
        case 'evaluator.requested':
        case 'runtime.child.close.requested':
        case 'runtime.child.settled':
        case 'runtime.effect.ambiguous':
        case 'runtime.effect.attempt.started':
        case 'runtime.effect.cancel.requested':
        case 'runtime.effect.cancelled':
        case 'runtime.effect.completed':
        case 'runtime.effect.dispatch.deferred':
        case 'runtime.effect.dispatched':
        case 'runtime.effect.failed':
        case 'runtime.effect.heartbeat':
        case 'runtime.effect.queued':
        case 'runtime.effect.retry.scheduled':
        case 'runtime.effect.timed_out':
        case 'runtime.effect.worker.started':
        case 'runtime.fork.elided':
        case 'runtime.run.cancelled':
        case 'runtime.run.completed':
        case 'runtime.run.forked':
        case 'runtime.run.launched':
        case 'runtime.run.started':
        case 'runtime.signal.received':
        case 'runtime.snapshot.taken':
        case 'runtime.thread.cancel.requested':
        case 'runtime.thread.cancelled':
        case 'runtime.thread.completed':
        case 'runtime.thread.failed':
        case 'runtime.timer.fired':
        case 'runtime.timer.set':
        case 'runtime.wait.registered':
        case 'shuttle.pr.discarded':
        case 'shuttle.review.comment.drafted':
        case 'shuttle.sandbox.moved':
        case 'shuttle.team.changed':
        case 'shuttle.turn.thinking_delta':
        case 'shuttle.turn.thought':
        case 'shuttle.vendor.message':
        case 'shuttle.vendor.tool_finished':
        case 'shuttle.vendor.tool_started':
        case 'shuttle.vendor.turn_started':
          return state
      }
    },
    effects(state, ctx) {
      const effects: RuntimeEffect[] = []
      const conductorThreadId = liveConductorThreadId(state.conductor)

      if (!state.sandboxBound && isPresent(state.sandboxName)) {
        const bindInput: JsonObjectBuilder = {
          sandboxName: state.sandboxName,
          repos: state.repos.map((repo) => ({
            installationId: repo.installationId,
            owner: repo.owner,
            name: repo.name,
            fullName: repo.fullName,
            defaultBranch: repo.defaultBranch,
            private: repo.private,
          })),
        }

        if (state.pull !== null) {
          bindInput.pull = {
            fullName: state.pull.fullName,
            number: state.pull.number,
            headSha: state.pull.headSha,
            baseSha: state.pull.baseSha,
          }
        }

        effects.push(invoke('shuttle.bindSandbox', bindInput, 'bind_sandbox'))
      }

      appendPrPublishEffects(state, effects)

      // The PR button: open the publish gate on the conductor's thread, so the card sits with the
      // agent's work. The gate's invoke key makes a repeat of this a no-op.
      if (
        state.pendingPrRequest !== undefined &&
        state.pendingPrRequest !== null &&
        state.pendingPrPublish === null
      ) {
        const request = state.pendingPrRequest

        const gateInput: JsonObjectBuilder = {
          approvalId: request.approvalId,
          title: request.title,
          body: request.body,
          draft: request.draft,
          repos: isPresent(request.repo) ? [request.repo] : [],
          fallbackTitle: firstLine(state.goal),
        }

        if (isPresent(request.repo)) {
          gateInput.repo = request.repo
        }

        if (isPresent(conductorThreadId)) {
          gateInput.threadId = conductorThreadId
        }

        effects.push(
          invoke('shuttle.preparePrPublishGate', gateInput, `prepare_pr_${request.approvalId}`),
        )
      }

      if (state.pendingReviewSubmit?.status === 'submitting') {
        const pending = state.pendingReviewSubmit

        effects.push(
          invoke(
            'shuttle.submitReview',
            {
              approvalId: pending.approvalId,
              threadId: deterministicThreadId(ctx.threadId, 'reviewer', 'main'),
              fullName: pending.fullName,
              number: pending.number,
              commitId: pending.commitId,
              summary: pending.summary,
              verdict: pending.verdict,
              comments: [...pending.comments],
            },
            `submit_review_${pending.approvalId}`,
          ),
        )
      }

      if (state.pull !== null && state.sandboxBound && !state.reviewerSpawned) {
        const childThreadId = deterministicThreadId(ctx.threadId, 'reviewer', 'main')

        effects.push(
          spawn({
            childThreadId,
            kind: 'agent',
            definitionName: 'reviewer',
            input: {
              text: state.goal,
              pull: {
                fullName: state.pull.fullName,
                number: state.pull.number,
                headSha: state.pull.headSha,
              },
            },
          }),
          emit(
            shuttleModule.input('conductor.spawned', {
              childThreadId,
              generation: 0,
              reason: 'initial',
            }),
            'reviewer_spawned',
          ),
        )
      }

      // Route before spawning so task/idea/constraint can queue onto state, then the next
      // wake includes those messages in the conductor's spawn input.
      if (state.pendingRoute !== null) {
        const route = state.pendingRoute
        const { summary, queued } = routeForEffects(state, route, effects, ctx.threadId, ctx.runId)

        effects.push(
          emit(
            shuttleModule.input('routed', {
              messageId: route.messageId,
              kind: route.kind,
              targetThreadId: route.targetThreadId,
              summary,
              briefVersion: state.briefVersion,
              queued,
            }),
            `routed_${route.messageId}`,
          ),
        )

        return effects
      }

      if (!state.pull && shouldSpawnConductor(state.conductor)) {
        const { generation } = state.conductor
        const childThreadId = conductorChildThreadId(ctx.threadId, generation)

        const startingFiles = [
          ...(state.initialAttachments ?? []),
          ...queuedAttachments(state.conductor),
        ]

        const conductorInput: JsonObjectBuilder = {
          text: withAttachmentManifest(
            buildConductorInput({
              runId: ctx.runId,
              goal: state.goal,
              briefText: state.briefText,
              briefVersion: state.briefVersion,
              repoUrl: state.repoUrl,
              repos: state.repos,
              lessons: state.lessons,
              playbookVersion: state.playbookVersion,
              conductor: state.conductor,
              speakerIds: state.speakerIds,
            }),
            ctx.runId,
            state.initialAttachments,
          ),
          repos: state.repos.map((repo) => repo.fullName),
        }

        if (startingFiles.length > 0) {
          conductorInput.attachments = startingFiles
        }

        effects.push(
          emit(
            shuttleModule.input('playbook.loaded', {
              version: state.playbookVersion,
              lessons: state.lessons.map((lesson) => ({
                id: lesson.id,
                text: lesson.text,
                scope: lesson.scope,
              })),
            }),
            'playbook_loaded',
          ),
          emit(
            shuttleModule.input('conductor.spawned', {
              childThreadId,
              generation,
              reason: spawnReason(state.conductor),
            }),
            `conductor_spawned_${generation}`,
          ),
          spawn({
            childThreadId,
            kind: 'agent',
            definitionName: 'conductor',
            input: conductorInput,
          }),
        )
      }

      if (state.activeIntake !== null) {
        effects.push(
          spawn({
            childThreadId: state.activeIntake.childThreadId,
            kind: 'evaluator',
            definitionName: 'intake',
            input: {
              text: state.activeIntake.text,
              activeWorkers: state.workerThreadIds,
              hasConductor: conductorThreadId !== null,
            },
          }),
          wait({
            waitId: createWaitId(ctx.threadId, `intake_${state.activeIntake.messageId}`),
            on: {
              type: [
                'runtime.thread.completed',
                'runtime.thread.failed',
                'runtime.thread.cancelled',
              ],
              match: { threadId: state.activeIntake.childThreadId },
            },
            tag: { kind: 'shuttle-intake', messageId: state.activeIntake.messageId },
          }),
        )

        return effects
      }

      const next = state.pendingMessages[0]

      if (next !== undefined) {
        const bypassKind = bypassIntakeKind(next)

        if (bypassKind !== null) {
          effects.push(
            emit(
              shuttleModule.input('intake.bypassed', {
                messageId: next.messageId,
                kind: bypassKind,
                targetThreadId: next.targetThreadId ?? null,
                text: next.text,
              }),
              `intake_bypass_${next.messageId}`,
            ),
          )

          return effects
        }

        const childThreadId = deterministicThreadId(ctx.threadId, 'intake', next.messageId)

        effects.push(
          emit(
            shuttleModule.input('intake.started', {
              messageId: next.messageId,
              childThreadId,
            }),
            `intake_start_${next.messageId}`,
          ),
        )

        return effects
      }

      for (const narratorId of state.activeNarrators) {
        effects.push(
          wait({
            waitId: createWaitId(ctx.threadId, `narrator_${narratorId}`),
            on: {
              type: [
                'runtime.thread.completed',
                'runtime.thread.failed',
                'runtime.thread.cancelled',
              ],
              match: { threadId: narratorId },
            },
            tag: { kind: 'shuttle-narrator', childThreadId: narratorId },
          }),
        )
      }

      // Dedicated waits so worker completion is tracked even if the mailbox is between arms.
      for (const workerId of state.workerThreadIds) {
        effects.push(
          wait({
            waitId: createWaitId(ctx.threadId, `worker_${workerId}`),
            on: {
              type: [
                'runtime.thread.completed',
                'runtime.thread.failed',
                'runtime.thread.cancelled',
              ],
              match: { threadId: workerId },
            },
            tag: { kind: 'shuttle-worker', childThreadId: workerId },
          }),
        )
      }

      if (conductorThreadId !== null) {
        effects.push(
          wait({
            waitId: createWaitId(
              ctx.threadId,
              `conductor_${conductorThreadId}_${state.conductor.generation}`,
            ),
            on: {
              type: [
                'runtime.thread.completed',
                'runtime.thread.failed',
                'runtime.thread.cancelled',
              ],
              match: { threadId: conductorThreadId },
            },
            tag: {
              kind: 'shuttle-conductor',
              childThreadId: conductorThreadId,
              generation: state.conductor.generation,
            },
          }),
        )
      }

      if (
        !state.reflectionLaunched &&
        conductorThreadId !== null &&
        state.workerThreadIds.length === 0 &&
        state.pendingMessages.length === 0 &&
        state.processedMessageIds.length > 0
      ) {
        const reflectionRun = reflectionRunId(ctx.runId)

        effects.push(
          launch({
            runId: reflectionRun,
            kind: 'agent',
            definitionName: 'reflector',
            input: {
              text: `Reflect on session ${ctx.runId}. Propose one concrete lesson from friction (corrections, stops, tool failures).`,
              sessionRunId: ctx.runId,
              playbookRunId: state.playbookRunId,
            },
            close: 'wait',
          }),
          emit(
            shuttleModule.input('reflection.launched', { runId: reflectionRun }),
            'reflection_launched',
          ),
        )
      }

      effects.push(
        wait({
          waitId: createWaitId(ctx.threadId, `mailbox_${state.mailboxEpoch}`),
          on: {
            type: [
              'shuttle.user.said',
              'shuttle.reroute',
              'shuttle.pr.proposed',
              'shuttle.pr.requested',
              'shuttle.pr.published',
              'shuttle.pr.publish_failed',
              'shuttle.review.submitted',
              'shuttle.review.submit_failed',
              'approval.decided',
              'agent.spawn.requested',
              'runtime.thread.completed',
              'runtime.thread.failed',
              'runtime.thread.cancelled',
            ],
          },
          tag: { kind: 'shuttle-mailbox' },
        }),
      )

      return effects
    },
  })
}

import { Predicate } from 'effect'

import {
  cancel,
  createWaitId,
  deterministicThreadId,
  emit,
  invoke,
  launch,
  spawn,
  wait,
  type EventEnvelope,
  type JsonValue,
  type RuntimeEffect,
  type ThreadDefinition,
} from '@swirls/looms/core'

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
} from './conductor'
import { shuttleModule } from './scope'

export type InterjectionKind = 'question' | 'idea' | 'constraint' | 'correction' | 'task' | 'stop'

export interface PendingMessage {
  readonly messageId: string
  readonly text: string
  readonly forceKind?: InterjectionKind
  readonly targetThreadId?: string
}

export interface ActiveIntake {
  readonly messageId: string
  readonly childThreadId: string
  readonly text: string
  readonly forceKind?: InterjectionKind
  readonly targetThreadId?: string
}

export interface PendingRoute {
  readonly messageId: string
  readonly kind: InterjectionKind
  readonly targetThreadId: string | null
  readonly text: string
}

export interface LinkedSessionRepo {
  readonly installationId: number
  readonly owner: string
  readonly name: string
  readonly fullName: string
  readonly defaultBranch: string
  readonly private: boolean
}

export interface SessionState {
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
}

function asObject(value: unknown): { [key: string]: JsonValue } {
  return Predicate.isObject(value) ? (value as { [key: string]: JsonValue }) : {}
}

function objectPayload(event: EventEnvelope): { [key: string]: JsonValue } {
  return asObject(event.payload)
}

function asString(value: JsonValue | undefined): string | null {
  return Predicate.isString(value) ? value : null
}

function asEventLike(
  value: unknown,
): { type?: string; payload?: JsonValue; threadId?: string | null } | null {
  if (!Predicate.isObject(value)) {
    return null
  }

  return value as { type?: string; payload?: JsonValue; threadId?: string | null }
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

  if (route) {
    return route
  }

  const answers = asObject(output.answers)
  const kindAnswer = asObject(answers.kind)
  const fromAnswer = readKind(kindAnswer.value)

  if (fromAnswer) {
    return fromAnswer
  }

  return fallback ?? 'task'
}

function steerEvent(threadId: string, content: string, interrupt: boolean, messageId?: string) {
  return {
    type: 'agent.steered' as const,
    payload: {
      turn: 0,
      ...(messageId ? { messageId } : {}),
      message: { role: 'user' as const, content },
      interrupt,
    },
    threadId,
  }
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
          typeof item.private !== 'boolean'
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

      return {
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

        case 'shuttle.playbook.loaded': {
          return {
            ...state,
            playbookVersion: event.payload.version,
            lessons: event.payload.lessons,
          }
        }

        case 'shuttle.conductor.spawned': {
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

          return {
            ...state,
            pendingMessages: [
              ...state.pendingMessages,
              {
                messageId: payload.messageId,
                text: payload.text,
                forceKind: payload.forceKind,
                targetThreadId: payload.targetThreadId,
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
            },
          }
        }

        case 'runtime.wait.satisfied': {
          const payload = objectPayload(event)
          const tag = asObject(payload.tag)
          const embedded = asEventLike(payload.event)
          const embeddedPayload = asObject(embedded?.payload)
          // Stable wait ids stay completed forever unless we bump the epoch.
          const base = { ...state, mailboxEpoch: state.mailboxEpoch + 1 }

          if (tag.kind === 'shuttle-intake' && base.activeIntake) {
            const kind = base.activeIntake.forceKind ?? kindFromEvaluator(event, 'task')
            return {
              ...base,
              activeIntake: null,
              pendingRoute: {
                messageId: base.activeIntake.messageId,
                kind,
                targetThreadId: base.activeIntake.targetThreadId ?? null,
                text: base.activeIntake.text,
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

            if (!childThreadId) {
              return base
            }

            return applyChildTerminal(base, childThreadId, conductorEndReason(embedded?.type))
          }

          if (embedded?.type === 'agent.spawn.requested') {
            const definitionName = asString(embeddedPayload.definitionName)
            const childThreadId = asString(embeddedPayload.childThreadId)

            if (
              definitionName === 'worker' &&
              childThreadId &&
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
            const threadId = asString(embeddedPayload.threadId) ?? embedded?.threadId

            if (!threadId) {
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
              queued && route
                ? queueForConductor(state.conductor, {
                    messageId: route.messageId,
                    text: route.text,
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

        default:
          return state
      }
    },
    effects(state, ctx) {
      const effects: RuntimeEffect[] = []
      const conductorThreadId = liveConductorThreadId(state.conductor)

      if (!state.sandboxBound && state.sandboxName) {
        effects.push(
          invoke(
            'shuttle.bindSandbox',
            {
              sandboxName: state.sandboxName,
              repos: state.repos.map((repo) => ({
                installationId: repo.installationId,
                owner: repo.owner,
                name: repo.name,
                fullName: repo.fullName,
                defaultBranch: repo.defaultBranch,
                private: repo.private,
              })),
            },
            'bind_sandbox',
          ),
        )
      }

      // Route before spawning so task/idea/constraint can queue onto state, then the next
      // wake includes those messages in the conductor's spawn input.
      if (state.pendingRoute) {
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

      if (shouldSpawnConductor(state.conductor)) {
        const { generation } = state.conductor
        const childThreadId = conductorChildThreadId(ctx.threadId, generation)

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
            input: {
              text: buildConductorInput({
                goal: state.goal,
                briefText: state.briefText,
                briefVersion: state.briefVersion,
                repoUrl: state.repoUrl,
                repos: state.repos,
                lessons: state.lessons,
                playbookVersion: state.playbookVersion,
                conductor: state.conductor,
              }),
            },
          }),
        )
      }

      if (state.activeIntake) {
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

      if (next) {
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

      if (conductorThreadId) {
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
        conductorThreadId &&
        state.workerThreadIds.length === 0 &&
        state.pendingMessages.length === 0 &&
        !state.activeIntake &&
        state.processedMessageIds.length > 0
      ) {
        const reflectionRunId = `reflect_${ctx.runId}`

        effects.push(
          launch({
            runId: reflectionRunId,
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
            shuttleModule.input('reflection.launched', { runId: reflectionRunId }),
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

interface RouteResult {
  readonly summary: string
  readonly queued: boolean
}

function routeForEffects(
  state: SessionState,
  route: PendingRoute,
  effects: RuntimeEffect[],
  sessionThreadId: string,
  runId: string,
): RouteResult {
  const conductorThreadId = liveConductorThreadId(state.conductor)

  const target =
    route.targetThreadId ??
    (route.kind === 'correction' || route.kind === 'stop'
      ? (state.workerThreadIds[0] ?? conductorThreadId)
      : conductorThreadId)

  switch (route.kind) {
    case 'question': {
      const childThreadId = deterministicThreadId(sessionThreadId, 'narrator', route.messageId)

      effects.push(
        emit(
          shuttleModule.input('narrator.spawned', {
            messageId: route.messageId,
            childThreadId,
          }),
          `narrator_${route.messageId}`,
        ),
        spawn({
          childThreadId,
          kind: 'agent',
          definitionName: 'narrator',
          input: {
            text: route.text,
            sessionRunId: runId,
            brief: state.briefText,
            workers: state.workerThreadIds,
          },
        }),
      )

      return { summary: 'answered by narrator', queued: false }
    }

    case 'idea':

    case 'constraint': {
      const nextVersion = state.briefVersion + 1
      const nextBrief = `${state.briefText}\n\n[${route.kind} v${nextVersion}] ${route.text}`

      effects.push(
        emit(
          shuttleModule.input('brief.amended', {
            version: nextVersion,
            text: nextBrief,
            sourceMessageId: route.messageId,
          }),
          `brief_${route.messageId}`,
        ),
      )

      const recipients = [
        ...(conductorThreadId ? [conductorThreadId] : []),
        ...state.workerThreadIds,
      ]

      if (recipients.length === 0) {
        return { summary: `brief v${nextVersion}; queued for conductor`, queued: true }
      }

      for (const threadId of recipients) {
        effects.push(
          emit(
            steerEvent(threadId, `Brief v${nextVersion}: ${route.text}`, false, route.messageId),
            `steer_brief_${route.messageId}_${threadId}`,
          ),
        )
      }

      return { summary: `brief v${nextVersion} to ${recipients.length} agents`, queued: false }
    }

    case 'correction': {
      if (!target) {
        return { summary: 'correction dropped (no target)', queued: false }
      }

      effects.push(
        emit(
          steerEvent(target, route.text, true, route.messageId),
          `steer_correction_${route.messageId}`,
        ),
      )

      return { summary: `interrupted ${target}`, queued: false }
    }

    case 'task': {
      if (!conductorThreadId) {
        return { summary: 'queued for conductor', queued: true }
      }

      effects.push(
        emit(
          steerEvent(conductorThreadId, route.text, false, route.messageId),
          `steer_task_${route.messageId}`,
        ),
      )

      return { summary: 'steered conductor', queued: false }
    }

    case 'stop': {
      if (!target) {
        return { summary: 'stop ignored (no target)', queued: false }
      }

      effects.push(
        emit(
          {
            type: 'agent.turn.stopped',
            payload: {},
            threadId: target,
          },
          `stop_${route.messageId}`,
        ),
      )

      // Stopping the conductor abandons its turn but keeps the thread alive for follow-ups.
      if (target !== conductorThreadId) {
        effects.push(cancel(target, `stop_cancel_${route.messageId}`))
      }

      return { summary: `stopped ${target}`, queued: false }
    }
  }
}

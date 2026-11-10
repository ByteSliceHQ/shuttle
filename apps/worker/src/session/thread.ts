import { Predicate } from 'effect'

import {
  cancel,
  createWaitId,
  deterministicThreadId,
  emit,
  launch,
  spawn,
  wait,
  type EventEnvelope,
  type JsonValue,
  type RuntimeEffect,
  type ThreadDefinition,
} from '@swirls/looms/core'

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

export interface SessionState {
  readonly goal: string
  readonly repoUrl: string | null
  readonly lessons: readonly { id: string; text: string; scope?: string }[]
  readonly playbookVersion: number
  readonly playbookRunId: string | null
  readonly conductorThreadId: string | null
  readonly briefVersion: number
  readonly briefText: string
  readonly pendingMessages: readonly PendingMessage[]
  readonly activeIntake: ActiveIntake | null
  readonly pendingRoute: PendingRoute | null
  readonly activeNarrators: readonly string[]
  readonly workerThreadIds: readonly string[]
  readonly processedMessageIds: readonly string[]
  readonly reflectionLaunched: boolean
  readonly parked: boolean
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

function asEventLike(value: unknown): { type?: string; payload?: JsonValue } | null {
  if (!Predicate.isObject(value)) {
    return null
  }

  return value as { type?: string; payload?: JsonValue }
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

      return {
        goal: asString(input.goal) ?? 'Improve the repository',
        repoUrl: asString(input.repoUrl),
        lessons,
        playbookVersion: Predicate.isNumber(input.playbookVersion) ? input.playbookVersion : 0,
        playbookRunId: asString(input.playbookRunId),
        conductorThreadId: null,
        briefVersion: 1,
        briefText: asString(input.goal) ?? 'Improve the repository',
        pendingMessages: [],
        activeIntake: null,
        pendingRoute: null,
        activeNarrators: [],
        workerThreadIds: [],
        processedMessageIds: [],
        reflectionLaunched: false,
        parked: false,
      }
    },
    step(state, event) {
      switch (event.type) {
        case 'runtime.thread.started': {
          return state
        }

        case 'shuttle.playbook.loaded': {
          return {
            ...state,
            playbookVersion: event.payload.version,
            lessons: event.payload.lessons,
          }
        }

        case 'shuttle.conductor.spawned': {
          return { ...state, conductorThreadId: event.payload.childThreadId }
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

          if (tag.kind === 'shuttle-intake' && state.activeIntake) {
            const kind = state.activeIntake.forceKind ?? kindFromEvaluator(event, 'task')
            return {
              ...state,
              activeIntake: null,
              pendingRoute: {
                messageId: state.activeIntake.messageId,
                kind,
                targetThreadId: state.activeIntake.targetThreadId ?? null,
                text: state.activeIntake.text,
              },
            }
          }

          if (tag.kind === 'shuttle-narrator') {
            const childThreadId = asString(tag.childThreadId)
            return {
              ...state,
              activeNarrators: state.activeNarrators.filter((id) => id !== childThreadId),
            }
          }

          if (embedded?.type === 'agent.spawn.requested') {
            const definitionName = asString(embeddedPayload.definitionName)
            const childThreadId = asString(embeddedPayload.childThreadId)

            if (
              definitionName === 'worker' &&
              childThreadId &&
              !state.workerThreadIds.includes(childThreadId)
            ) {
              return {
                ...state,
                workerThreadIds: [...state.workerThreadIds, childThreadId],
              }
            }
          }

          if (
            embedded?.type === 'runtime.thread.completed' ||
            embedded?.type === 'runtime.thread.failed' ||
            embedded?.type === 'runtime.thread.cancelled'
          ) {
            const threadId = asString(embeddedPayload.threadId)

            if (!threadId) {
              return state
            }

            return {
              ...state,
              workerThreadIds: state.workerThreadIds.filter((id) => id !== threadId),
              activeNarrators: state.activeNarrators.filter((id) => id !== threadId),
            }
          }

          return state
        }

        case 'shuttle.routed': {
          return { ...state, pendingRoute: null }
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

      if (!state.conductorThreadId) {
        const childThreadId = deterministicThreadId(ctx.threadId, 'conductor')

        const lessonBlock =
          state.lessons.length > 0
            ? `\n\nPlaybook v${state.playbookVersion}:\n${state.lessons.map((lesson) => `- ${lesson.text}`).join('\n')}`
            : ''

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
          emit(shuttleModule.input('conductor.spawned', { childThreadId }), 'conductor_spawned'),
          spawn({
            childThreadId,
            kind: 'agent',
            definitionName: 'conductor',
            input: {
              text: `${state.goal}${lessonBlock}\n\nRepo: ${state.repoUrl ?? 'local demo workspace'}`,
            },
          }),
        )
      }

      if (state.pendingRoute) {
        const route = state.pendingRoute
        const summary = routeForEffects(state, route, effects, ctx.threadId, ctx.runId)

        effects.push(
          emit(
            shuttleModule.input('routed', {
              messageId: route.messageId,
              kind: route.kind,
              targetThreadId: route.targetThreadId,
              summary,
              briefVersion: state.briefVersion,
            }),
            `routed_${route.messageId}`,
          ),
        )

        return effects
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
              hasConductor: Boolean(state.conductorThreadId),
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

      if (
        !state.reflectionLaunched &&
        state.conductorThreadId &&
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
          waitId: createWaitId(ctx.threadId, 'mailbox'),
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

function routeForEffects(
  state: SessionState,
  route: PendingRoute,
  effects: RuntimeEffect[],
  sessionThreadId: string,
  runId: string,
): string {
  const target =
    route.targetThreadId ??
    (route.kind === 'correction' || route.kind === 'stop'
      ? (state.workerThreadIds[0] ?? state.conductorThreadId)
      : state.conductorThreadId)

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

      return 'answered by narrator'
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
        ...(state.conductorThreadId ? [state.conductorThreadId] : []),
        ...state.workerThreadIds,
      ]

      for (const threadId of recipients) {
        effects.push(
          emit(
            steerEvent(threadId, `Brief v${nextVersion}: ${route.text}`, false, route.messageId),
            `steer_brief_${route.messageId}_${threadId}`,
          ),
        )
      }

      return `brief v${nextVersion} to ${recipients.length} agents`
    }

    case 'correction': {
      if (!target) {
        return 'correction dropped (no target)'
      }

      effects.push(
        emit(
          steerEvent(target, route.text, true, route.messageId),
          `steer_correction_${route.messageId}`,
        ),
      )

      return `interrupted ${target}`
    }

    case 'task': {
      if (!state.conductorThreadId) {
        return 'task queued (no conductor yet)'
      }

      effects.push(
        emit(
          steerEvent(state.conductorThreadId, route.text, false, route.messageId),
          `steer_task_${route.messageId}`,
        ),
      )

      return 'steered conductor'
    }

    case 'stop': {
      if (!target) {
        return 'stop ignored (no target)'
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
        cancel(target, `stop_cancel_${route.messageId}`),
      )

      return `stopped ${target}`
    }
  }
}

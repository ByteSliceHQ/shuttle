import { Predicate, Schema } from 'effect'
import { z } from 'zod'

import { gate } from '@swirls/looms/approval'
import {
  createWaitId,
  DEFAULT_DEFINITION_VERSION,
  defineKind,
  emit,
  wait,
  type RuntimeEffect,
  type ThreadDefinition,
} from '@swirls/looms/core'

import { reflectModule } from './scope'

export const PlaybookInputSchema = z.object({
  title: z.string().default('Shuttle playbook'),
})

export const playbookDefinition = defineKind('reflect-playbook', {
  name: 'playbook',
  version: DEFAULT_DEFINITION_VERSION,
  description: 'Long-lived approved lessons for Shuttle sessions',
  input: PlaybookInputSchema,
})

export interface PlaybookLesson {
  readonly id: string
  readonly text: string
  readonly scope: string
  readonly status: 'proposed' | 'approved' | 'rejected' | 'retired'
  readonly evidence: readonly { readonly runId: string; readonly seq: number }[]
  readonly sourceRunId: string
  readonly approvalId?: string
  readonly mirrored?: boolean
}

export interface PlaybookState {
  readonly title: string
  readonly lessons: readonly PlaybookLesson[]
  readonly pendingApprovals: readonly string[]
  readonly version: number
}

export function createPlaybookThread(): ThreadDefinition<PlaybookState> {
  return reflectModule.thread<PlaybookState>({
    kind: 'reflect-playbook',
    initialState: (ctx) => {
      const input = Predicate.isObject(ctx.input) ? ctx.input : {}
      return {
        title: Predicate.isString(input.title) ? input.title : 'Shuttle playbook',
        lessons: [],
        pendingApprovals: [],
        version: 0,
      }
    },
    step(state, event) {
      switch (event.type) {
        case 'reflect.lesson.proposed': {
          if (state.lessons.some((lesson) => lesson.id === event.payload.lessonId)) {
            return state
          }

          const approvalId = `lesson_${event.payload.lessonId}`
          return {
            ...state,
            lessons: [
              ...state.lessons,
              {
                id: event.payload.lessonId,
                text: event.payload.text,
                scope: event.payload.scope,
                status: 'proposed' as const,
                evidence: event.payload.evidence,
                sourceRunId: event.payload.sourceRunId,
                approvalId,
              },
            ],
            pendingApprovals: [...state.pendingApprovals, approvalId],
          }
        }

        case 'approval.decided': {
          const approvalId = event.payload.approvalId
          const lesson = state.lessons.find((item) => item.approvalId === approvalId)

          if (!lesson) {
            return state
          }

          const approved = event.payload.outcome === 'approve'
          return {
            ...state,
            lessons: state.lessons.map((item) =>
              item.id === lesson.id
                ? {
                    ...item,
                    status: approved ? ('approved' as const) : ('rejected' as const),
                    mirrored: false,
                  }
                : item,
            ),
            pendingApprovals: state.pendingApprovals.filter((id) => id !== approvalId),
            version: approved ? state.version + 1 : state.version,
          }
        }

        case 'reflect.lesson.approved':

        case 'reflect.lesson.rejected': {
          return {
            ...state,
            lessons: state.lessons.map((item) =>
              item.id === event.payload.lessonId ? { ...item, mirrored: true } : item,
            ),
          }
        }

        case 'reflect.lesson.retired': {
          return {
            ...state,
            lessons: state.lessons.map((item) =>
              item.id === event.payload.lessonId
                ? { ...item, status: 'retired' as const, mirrored: true }
                : item,
            ),
            version: state.version + 1,
          }
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
        case 'reflect.friction.recorded':
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
        case 'runtime.thread.started':
        case 'runtime.timer.fired':
        case 'runtime.timer.set':
        case 'runtime.wait.registered':
        case 'runtime.wait.satisfied':
          return state
      }
    },
    effects(state, ctx) {
      const effects: RuntimeEffect[] = []

      for (const approvalId of state.pendingApprovals) {
        const lesson = state.lessons.find((item) => item.approvalId === approvalId)

        if (!lesson || lesson.status !== 'proposed') {
          continue
        }

        effects.push(
          ...gate({
            approvalId,
            title: 'Approve playbook lesson?',
            description: lesson.text,
          }),
        )
      }

      for (const lesson of state.lessons) {
        if (lesson.mirrored === true) {
          continue
        }

        if (lesson.status === 'approved') {
          effects.push(
            emit(
              reflectModule.input('lesson.approved', { lessonId: lesson.id }),
              `mirror_approved_${lesson.id}`,
            ),
          )
        }

        if (lesson.status === 'rejected') {
          effects.push(
            emit(
              reflectModule.input('lesson.rejected', { lessonId: lesson.id }),
              `mirror_rejected_${lesson.id}`,
            ),
          )
        }
      }

      effects.push(
        wait({
          waitId: createWaitId(ctx.threadId, 'playbook_mailbox'),
          on: {
            type: [
              'reflect.lesson.proposed',
              'reflect.lesson.approved',
              'reflect.lesson.rejected',
              'reflect.lesson.retired',
              'approval.decided',
            ],
          },
          tag: { kind: 'playbook-mailbox' },
        }),
      )

      return effects
    },
  })
}

const EvidenceSchema = Schema.Struct({
  runId: Schema.String,
  seq: Schema.Finite,
})

const ProposedLessonSchema = Schema.Struct({
  text: Schema.String,
  scope: Schema.String,
  evidence: Schema.Array(EvidenceSchema),
  sourceRunId: Schema.String,
})

const ActiveLessonSchema = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  scope: Schema.String,
  evidence: Schema.Array(EvidenceSchema),
  sourceRunId: Schema.String,
})

export const activePlaybook = reflectModule.projection({
  name: 'activePlaybook',
  shape: Schema.Struct({
    version: Schema.Finite,
    lessons: Schema.Array(ActiveLessonSchema),
    proposed: Schema.Record(Schema.String, ProposedLessonSchema),
  }),
  initialState: { version: 0, lessons: [], proposed: {} },
  reduce(state, event) {
    if (event.type === 'reflect.lesson.proposed') {
      return {
        version: state.version,
        lessons: state.lessons,
        proposed: {
          ...state.proposed,
          [event.payload.lessonId]: {
            text: event.payload.text,
            scope: event.payload.scope,
            evidence: [...event.payload.evidence],
            sourceRunId: event.payload.sourceRunId,
          },
        },
      }
    }

    if (event.type === 'reflect.lesson.approved') {
      const proposed = state.proposed[event.payload.lessonId]

      if (!proposed || state.lessons.some((lesson) => lesson.id === event.payload.lessonId)) {
        return state
      }

      const rest = { ...state.proposed }
      delete rest[event.payload.lessonId]

      return {
        version: state.version + 1,
        lessons: [
          ...state.lessons,
          {
            id: event.payload.lessonId,
            text: proposed.text,
            scope: proposed.scope,
            evidence: [...proposed.evidence],
            sourceRunId: proposed.sourceRunId,
          },
        ],
        proposed: rest,
      }
    }

    if (event.type === 'reflect.lesson.retired') {
      return {
        version: state.version + 1,
        lessons: state.lessons.filter((lesson) => lesson.id !== event.payload.lessonId),
        proposed: state.proposed,
      }
    }

    return state
  },
})

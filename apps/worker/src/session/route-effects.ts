import { cancel, deterministicThreadId, emit, spawn, type RuntimeEffect } from '@swirls/looms/core'

import { attributed } from './attribution'
import { liveConductorThreadId } from './conductor'
import { shuttleModule } from './scope'
import type { PendingRoute, SessionState } from './thread'

export interface RouteResult {
  readonly summary: string
  readonly queued: boolean
}

/**
 * A message for an agent. `sponsorId` marks it as work someone asked for: the turn it starts runs
 * on that person's sign-in (see `sponsor.ts`). Questions and brief changes carry none, so they
 * never change whose sign-in the work runs on.
 */
function steerEvent(
  threadId: string,
  content: string,
  interrupt: boolean,
  messageId?: string,
  sponsorId?: string,
) {
  return {
    type: 'agent.steered' as const,
    payload: {
      turn: 0,
      ...(messageId ? { messageId } : {}),
      message: { role: 'user' as const, content, ...(sponsorId ? { name: sponsorId } : {}) },
      interrupt,
    },
    threadId,
  }
}

export function routeForEffects(
  state: SessionState,
  route: PendingRoute,
  effects: RuntimeEffect[],
  sessionThreadId: string,
  runId: string,
): RouteResult {
  const conductorThreadId = liveConductorThreadId(state.conductor)
  const text = attributed(route, state.speakerIds)

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
            text,
            messageId: route.messageId,
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
      const nextBrief = `${state.briefText}\n\n[${route.kind} v${nextVersion}] ${text}`

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
            steerEvent(threadId, `Brief v${nextVersion}: ${text}`, false, route.messageId),
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
          steerEvent(target, text, true, route.messageId, route.author?.id),
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
          steerEvent(conductorThreadId, text, false, route.messageId, route.author?.id),
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

    default: {
      const exhaustive: never = route.kind
      return exhaustive
    }
  }
}

import { cancel, deterministicThreadId, emit, spawn, type RuntimeEffect } from '@swirls/looms/core'

import { attributedWithFiles } from './attribution'
import { liveConductorThreadId } from './conductor'
import type { JsonObjectBuilder } from './json-object'
import { shuttleModule, type AttachmentRef } from './scope'
import type { PendingRoute, SessionState } from './thread'

export interface RouteResult {
  readonly summary: string
  readonly queued: boolean
}

type SteerMessage = {
  role: 'user'
  content: string
  name?: string
  attachments?: AttachmentRef[]
}

type SteerPayload = {
  turn: number
  messageId?: string
  message: SteerMessage
  interrupt: boolean
}

/** True for a string that is neither missing nor empty. */
function isPresent(value: string | undefined | null): value is string {
  return value !== undefined && value !== null && value !== ''
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
  attachments?: readonly AttachmentRef[],
) {
  const message: SteerMessage = { role: 'user', content }

  if (isPresent(sponsorId)) {
    message.name = sponsorId
  }

  // Sent to the model itself where it can read them. The text already says where each is.
  if (attachments !== undefined && attachments.length > 0) {
    message.attachments = [...attachments]
  }

  const payload: SteerPayload = { turn: 0, message, interrupt }

  if (isPresent(messageId)) {
    payload.messageId = messageId
  }

  return { type: 'agent.steered' as const, payload, threadId }
}

export function routeForEffects(
  state: SessionState,
  route: PendingRoute,
  effects: RuntimeEffect[],
  sessionThreadId: string,
  runId: string,
): RouteResult {
  const conductorThreadId = liveConductorThreadId(state.conductor)
  const text = attributedWithFiles(route, state.speakerIds, runId)
  const { attachments } = route

  const target =
    route.targetThreadId ??
    (route.kind === 'correction' || route.kind === 'stop'
      ? (state.workerThreadIds[0] ?? conductorThreadId)
      : conductorThreadId)

  switch (route.kind) {
    case 'question': {
      const childThreadId = deterministicThreadId(sessionThreadId, 'narrator', route.messageId)

      const narratorInput: JsonObjectBuilder = {
        text,
        messageId: route.messageId,
        sessionRunId: runId,
        brief: state.briefText,
        workers: state.workerThreadIds,
      }

      if (attachments !== undefined && attachments.length > 0) {
        narratorInput.attachments = [...attachments]
      }

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
          input: narratorInput,
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
        ...(isPresent(conductorThreadId) ? [conductorThreadId] : []),
        ...state.workerThreadIds,
      ]

      if (recipients.length === 0) {
        return { summary: `brief v${nextVersion}; queued for conductor`, queued: true }
      }

      for (const threadId of recipients) {
        effects.push(
          emit(
            steerEvent(
              threadId,
              `Brief v${nextVersion}: ${text}`,
              false,
              route.messageId,
              undefined,
              attachments,
            ),
            `steer_brief_${route.messageId}_${threadId}`,
          ),
        )
      }

      return { summary: `brief v${nextVersion} to ${recipients.length} agents`, queued: false }
    }

    case 'correction': {
      if (!isPresent(target)) {
        return { summary: 'correction dropped (no target)', queued: false }
      }

      effects.push(
        emit(
          steerEvent(target, text, true, route.messageId, route.author?.id, attachments),
          `steer_correction_${route.messageId}`,
        ),
      )

      return { summary: `interrupted ${target}`, queued: false }
    }

    case 'task': {
      if (!isPresent(conductorThreadId)) {
        return { summary: 'queued for conductor', queued: true }
      }

      effects.push(
        emit(
          steerEvent(
            conductorThreadId,
            text,
            false,
            route.messageId,
            route.author?.id,
            attachments,
          ),
          `steer_task_${route.messageId}`,
        ),
      )

      return { summary: 'steered conductor', queued: false }
    }

    case 'stop': {
      if (!isPresent(target)) {
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

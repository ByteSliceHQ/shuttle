import { Effect } from 'effect'

import { callLlmEffect } from '@swirls/looms/agent'
import { onEffect, type EventInput } from '@swirls/looms/core'

import {
  bindStepObserver,
  bindThinkingObserver,
  bindTurnThread,
  clearStepObserver,
  clearThinkingObserver,
  type VendorStep,
} from '../llm'
import type { JsonObjectBuilder } from './json-object'

/**
 * Wraps `agent.callLLM`: streams thinking deltas as ephemeral events while the model runs, then
 * records the finished thought on the log just before the agent's message.
 */
export const thinkingMiddleware = onEffect(callLlmEffect, (input, ctx, next) => {
  const turn = input.turn

  return Effect.gen(function* () {
    let thinking = ''
    let durationMs: number | undefined

    bindThinkingObserver(ctx.signal, {
      reset: () => {
        thinking = ''
        durationMs = undefined
      },
      onDelta: async (delta) => {
        thinking += delta

        await ctx.emit({
          type: 'shuttle.turn.thinking_delta',
          payload: { turn, delta },
          threadId: ctx.threadId,
          ephemeral: true,
        })
      },
      onComplete: (text, ms) => {
        thinking = text
        durationMs = ms
      },
    })

    // A vendor agent does its own planning and tool use inside the turn. Anything emitted while
    // an effect runs is ephemeral, so each step goes out live for the session view and is kept
    // to be returned with the turn's result, which is what makes it part of the history.
    const steps: EventInput[] = []

    bindTurnThread(ctx.signal, ctx.threadId)

    bindStepObserver(ctx.signal, {
      onStep: async (step) => {
        const event = vendorStepEvent(step, turn, ctx.threadId)

        steps.push(event)
        await ctx.emit(event)
      },
    })

    try {
      const produced = yield* next()
      const events = insertBeforeMessage(produced, steps)
      const text = thinking.trim()

      if (text === '') {
        return events
      }

      const thought: EventInput = {
        type: 'shuttle.turn.thought',
        payload: durationMs === undefined ? { turn, text } : { turn, text, durationMs },
        threadId: ctx.threadId,
      }

      return insertBeforeMessage(events, [thought])
    } finally {
      clearThinkingObserver(ctx.signal)
      clearStepObserver(ctx.signal)
    }
  })
})

/** Places `extra` just before the turn's message, or at the end when the turn produced none. */
function insertBeforeMessage<T extends { readonly type: string }>(
  events: ReadonlyArray<T>,
  extra: ReadonlyArray<T>,
): ReadonlyArray<T> {
  if (extra.length === 0) {
    return events
  }

  const messageIndex = events.findIndex((event) => event.type === 'agent.message')

  if (messageIndex < 0) {
    return [...events, ...extra]
  }

  return [...events.slice(0, messageIndex), ...extra, ...events.slice(messageIndex)]
}

export function vendorStepEvent(step: VendorStep, turn: number, threadId: string): EventInput {
  switch (step.type) {
    case 'started': {
      const started: JsonObjectBuilder = { turn, harness: step.harness, label: step.label }

      if (step.model !== undefined && step.model !== '') {
        started.model = step.model
      }

      if (step.billedTo !== undefined && step.billedTo !== '') {
        started.billedTo = step.billedTo
      }

      return {
        type: 'shuttle.vendor.turn_started',
        payload: started,
        threadId,
      }
    }

    case 'message': {
      return { type: 'shuttle.vendor.message', payload: { turn, text: step.text }, threadId }
    }

    case 'thought': {
      return {
        type: 'shuttle.turn.thought',
        payload:
          step.durationMs === undefined
            ? { turn, text: step.text }
            : { turn, text: step.text, durationMs: step.durationMs },
        threadId,
      }
    }

    case 'tool_started': {
      return {
        type: 'shuttle.vendor.tool_started',
        payload: { turn, toolCall: step.toolCall },
        threadId,
      }
    }

    case 'tool_finished': {
      return {
        type: 'shuttle.vendor.tool_finished',
        payload:
          step.error !== undefined && step.error !== ''
            ? { turn, toolCallId: step.toolCallId, result: step.result, error: step.error }
            : { turn, toolCallId: step.toolCallId, result: step.result },
        threadId,
      }
    }

    default: {
      const exhaustive: never = step
      return exhaustive
    }
  }
}

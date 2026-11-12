import { Effect } from 'effect'

import { callLlmEffect } from '@swirls/looms/agent'
import {
  isPrimitiveEffect,
  type EffectMiddleware,
  type EventInput,
  type JsonValue,
} from '@swirls/looms/core'

import { bindThinkingObserver, clearThinkingObserver } from '../llm'

/** The turn number from an `agent.callLLM` input, or null when the input does not carry one. */
function turnOf(input: JsonValue): number | null {
  if (input === null || typeof input !== 'object' || !('turn' in input)) {
    return null
  }

  const turn = input.turn

  return typeof turn === 'number' ? turn : null
}

/**
 * Wraps `agent.callLLM`: streams thinking deltas as ephemeral events while the model runs, then
 * records the finished thought on the log just before the agent's message.
 */
export const thinkingMiddleware: EffectMiddleware = (effect, ctx, next) => {
  if (isPrimitiveEffect(effect) || effect.type !== callLlmEffect.type) {
    return next(effect, ctx)
  }

  const turn = turnOf(effect.input)

  if (turn === null) {
    return next(effect, ctx)
  }

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

    try {
      const events = yield* next(effect, ctx)
      const text = thinking.trim()

      if (!text) {
        return events
      }

      const thought: EventInput = {
        type: 'shuttle.turn.thought',
        payload: {
          turn,
          text,
          ...(durationMs !== undefined ? { durationMs } : {}),
        },
        threadId: ctx.threadId,
      }

      const messageIndex = events.findIndex((event) => event.type === 'agent.message')

      if (messageIndex < 0) {
        return [...events, thought]
      }

      return [...events.slice(0, messageIndex), thought, ...events.slice(messageIndex)]
    } finally {
      clearThinkingObserver(ctx.signal)
    }
  })
}

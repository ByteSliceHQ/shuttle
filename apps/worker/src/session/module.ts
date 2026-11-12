import { Effect } from 'effect'

import { callLlmEffect } from '@swirls/looms/agent'
import {
  defineModule,
  onEffect,
  type DefinitionRef,
  type EventInput,
  type LocalEffectDefinition,
} from '@swirls/looms/core'

import type { ShuttleEnv } from '../env'
import { bindThinkingObserver, clearThinkingObserver } from '../llm'
import { createBindSandboxEffect } from './bind-sandbox'
import { codingSession, reviewSession } from './definitions'
import { createPreparePrPublishGateEffect } from './prepare-pr-publish-gate'
import { brief, routing, transcript, work } from './projections'
import { createPublishPullRequestEffect } from './publish-pr'
import { shuttleModule } from './scope'
import { reroute, say } from './signals'
import { createSubmitReviewEffect } from './submit-review'
import { createSessionThread } from './thread'

export interface ShuttleSessionOptions {
  readonly definitions?: readonly DefinitionRef[]
  readonly storage?: DurableObjectStorage
  readonly env?: ShuttleEnv
}

/** Decoded `agent.callLLM` input — enough for thinking middleware without the agent service R. */
type CallLlmInput = {
  readonly turn: number
}

const thinkingMiddleware = onEffect(
  callLlmEffect as unknown as LocalEffectDefinition<CallLlmInput>,
  (input, ctx, next) =>
    Effect.gen(function* () {
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
            payload: { turn: input.turn, delta },
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
        const events = yield* next()
        const text = thinking.trim()

        if (!text) {
          return events
        }

        const thought: EventInput = {
          type: 'shuttle.turn.thought',
          payload: {
            turn: input.turn,
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
    }),
)

export function shuttleSession(options: ShuttleSessionOptions = {}) {
  // Tests may omit env; publish/submit effects then no-op until a real env is provided.
  const env =
    options.env ??
    ({
      LOOMS_RUN: {} as DurableObjectNamespace,
      SANDBOX: {} as DurableObjectNamespace,
    } satisfies ShuttleEnv)

  return defineModule(shuttleModule, () => ({
    definitions: options.definitions ?? [codingSession, reviewSession],
    threads: {
      'shuttle-session': createSessionThread(),
    },
    projections: {
      brief,
      routing,
      transcript,
      work,
    },
    signals: {
      say,
      reroute,
    },
    effects: {
      bindSandbox: createBindSandboxEffect(options.env, options.storage),
      preparePrPublishGate: createPreparePrPublishGateEffect(env, options.storage),
      publishPullRequest: createPublishPullRequestEffect(env, options.storage),
      submitReview: createSubmitReviewEffect(env, options.storage),
    },
    middleware: [thinkingMiddleware],
  }))
}

export { say, reroute, brief, routing, transcript, work, codingSession, reviewSession }
export type { InterjectionKind, SessionState } from './thread'

import {
  generateText,
  jsonSchema,
  streamText,
  tool,
  type JSONSchema7,
  type LanguageModel,
} from 'ai'

import type { AgentTurnResult, LlmAdapter, LlmCompleteArgs, LlmToolSpec } from '@swirls/looms/agent'
import { toLoomsToolCalls, toModelMessages } from '@swirls/looms/ai-vercel'
import { asJson, type JsonValue } from '@swirls/looms/core'

export interface TurnThinkingObserver {
  /** Clears accumulated thinking when an LLM attempt restarts (e.g. after compaction). */
  reset(): void
  onDelta(delta: string): void | Promise<void>
  onComplete(text: string, durationMs: number): void
}

/** Per-attempt observers keyed by the AbortSignal Looms creates for each local effect. */
const thinkingObservers = new WeakMap<AbortSignal, TurnThinkingObserver>()

export function bindThinkingObserver(signal: AbortSignal, observer: TurnThinkingObserver): void {
  thinkingObservers.set(signal, observer)
}

export function getThinkingObserver(signal: AbortSignal): TurnThinkingObserver | undefined {
  return thinkingObservers.get(signal)
}

export function clearThinkingObserver(signal: AbortSignal): void {
  thinkingObservers.delete(signal)
}

function isJsonSchema(value: unknown): value is JSONSchema7 {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toAiTools(specs: ReadonlyArray<LlmToolSpec>) {
  return Object.fromEntries(
    specs.map((spec) => {
      if (!isJsonSchema(spec.inputJsonSchema)) {
        throw new Error(`Invalid JSON Schema for tool "${spec.name}"`)
      }

      return [
        spec.name,
        tool({
          description: spec.description,
          inputSchema: jsonSchema(spec.inputJsonSchema),
        }),
      ]
    }),
  )
}

function toolCallInput(call: { input?: unknown }): JsonValue {
  const input = 'input' in call ? call.input : {}
  return asJson(input ?? {})
}

function streamPartText(part: { type: string; text?: unknown; delta?: unknown }): string {
  if (typeof part.text === 'string' && part.text.length > 0) {
    return part.text
  }

  if (typeof part.delta === 'string' && part.delta.length > 0) {
    return part.delta
  }

  return ''
}

export type ReasoningEffort = 'high' | 'medium' | 'low'

/** Frontier high-effort models get more thinking; everything else stays medium. */
export function reasoningEffortFor(modelId: string): ReasoningEffort {
  const high = [
    'claude-fable',
    'claude-opus',
    'gpt-6-astra',
    'gemini-4-argon',
    'grok-4.7',
    'muse-wonder',
  ]

  if (high.some((marker) => modelId.includes(marker))) {
    return 'high'
  }

  return 'medium'
}

export interface ReasoningLlmOptions {
  readonly model: LanguageModel
  readonly stream?: boolean
}

/**
 * OpenRouter-aware LLM adapter that streams reasoning deltas to a bound observer
 * and preserves real token usage from the AI SDK.
 */
export function createReasoningLlm(options: ReasoningLlmOptions): LlmAdapter {
  const streamEnabled = options.stream !== false

  return {
    complete: async (args: LlmCompleteArgs): Promise<AgentTurnResult> => {
      const messages = toModelMessages(args.messages)

      const tools =
        args.toolSpecs && args.toolSpecs.length > 0 ? toAiTools(args.toolSpecs) : undefined

      const observer = args.signal ? thinkingObservers.get(args.signal) : undefined
      observer?.reset()

      let thinking = ''
      let thinkingStartedAt: number | undefined
      let thinkingEndedAt: number | undefined

      const noteThinking = async (delta: string) => {
        if (!delta) {
          return
        }

        const now = Date.now()

        if (thinkingStartedAt === undefined) {
          thinkingStartedAt = now
        }

        thinkingEndedAt = now
        thinking += delta
        await observer?.onDelta(delta)
      }

      const finishThinking = () => {
        const text = thinking.trim()

        if (!text || !observer) {
          return
        }

        const endedAt = thinkingEndedAt ?? Date.now()

        const durationMs =
          thinkingStartedAt !== undefined ? Math.max(0, endedAt - thinkingStartedAt) : 0

        observer.onComplete(text, durationMs)
      }

      if (streamEnabled && (args.onTextDelta || observer)) {
        const result = tools
          ? streamText({
              model: options.model,
              instructions: args.instructions,
              messages,
              abortSignal: args.signal,
              tools,
            })
          : streamText({
              model: options.model,
              instructions: args.instructions,
              messages,
              abortSignal: args.signal,
            })

        for await (const part of result.fullStream) {
          if (part.type === 'reasoning-start') {
            thinkingStartedAt ??= Date.now()
            continue
          }

          if (part.type === 'reasoning-delta') {
            await noteThinking(streamPartText(part))
            continue
          }

          if (part.type === 'reasoning-end') {
            thinkingEndedAt = Date.now()
            continue
          }

          if (part.type === 'text-delta') {
            if (thinkingStartedAt !== undefined && thinkingEndedAt === undefined) {
              thinkingEndedAt = Date.now()
            }

            const delta = streamPartText(part)

            if (delta) {
              await args.onTextDelta?.(delta)
            }
          }
        }

        try {
          const [text, rawToolCalls, reasoningText, usage] = await Promise.all([
            result.text,
            result.toolCalls,
            result.reasoningText,
            result.usage,
          ])

          if (!thinking.trim() && reasoningText?.trim()) {
            await noteThinking(reasoningText)
          }

          finishThinking()

          const toolCalls = toLoomsToolCalls(
            rawToolCalls.map((call) => ({
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              input: toolCallInput(call),
            })),
          )

          return {
            message: { role: 'assistant', content: text, toolCalls },
            toolCalls,
            usage: {
              input: usage?.inputTokens ?? 0,
              output: usage?.outputTokens ?? text.length,
            },
          }
        } catch (cause) {
          if (cause instanceof Error && cause.message.includes('No output generated')) {
            finishThinking()
            // Fall through to generateText.
          } else {
            throw cause
          }
        }
      }

      const result = tools
        ? await generateText({
            model: options.model,
            instructions: args.instructions,
            messages,
            abortSignal: args.signal,
            tools,
          })
        : await generateText({
            model: options.model,
            instructions: args.instructions,
            messages,
            abortSignal: args.signal,
          })

      if (!thinking.trim() && result.reasoningText?.trim()) {
        await noteThinking(result.reasoningText)
      }

      finishThinking()

      const toolCalls = toLoomsToolCalls(
        result.toolCalls.map((call) => ({
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: toolCallInput(call),
        })),
      )

      return {
        message: { role: 'assistant', content: result.text, toolCalls },
        toolCalls,
        usage: {
          input: result.usage?.inputTokens ?? 0,
          output: result.usage?.outputTokens ?? result.text.length,
        },
      }
    },
  }
}

/** Offline stub that still emits a short thought so the UI can be exercised without a key. */
export function createStubThinkingLlm(): LlmAdapter {
  return {
    complete: async (args) => {
      const last = args.messages.toReversed().find((message) => message.role === 'user')

      const text =
        typeof last?.content === 'string'
          ? last.content
          : 'Stub LLM: set OPENROUTER_API_KEY for live model calls.'

      const thought = `Considering how to respond to: ${text.slice(0, 120)}`
      const observer = args.signal ? thinkingObservers.get(args.signal) : undefined
      const startedAt = Date.now()

      if (observer) {
        observer.reset()
        await observer.onDelta(thought)
        observer.onComplete(thought, Math.max(1, Date.now() - startedAt))
      }

      const content = `[stub] Acknowledged: ${text.slice(0, 240)}`
      await args.onTextDelta?.(content)

      return {
        message: {
          role: 'assistant',
          content,
        },
        done: true,
        output: { stub: true },
        usage: { input: text.length, output: content.length },
      }
    },
  }
}

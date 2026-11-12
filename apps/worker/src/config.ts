import { createTypeSafeAi } from '@ai-sdk/typesafe-ai'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'

import type { LlmAdapter, LlmCompleteArgs } from '@swirls/looms/agent'
import { vercelEvaluator } from '@swirls/looms/ai-vercel'
import type {
  EvaluatorAdapter,
  EvaluatorEvaluateArgs,
  StubEvaluatorPolicy,
} from '@swirls/looms/evaluator'
import type { Projector } from '@swirls/looms/projectors'
import { d1ReplicaDatabase, sqliteReplica } from '@swirls/looms/projectors/replica/sqlite'

import { classifyHeuristic, parseIntakeMessage } from './agents/intake'
import { shuttleAttributes } from './attributes'
import type { ShuttleEnv } from './env'
import { createFirehoseProjector } from './firehose/projector'
import {
  createReasoningLlm,
  createStubThinkingLlm,
  reasoningEffortFor,
  type ReasoningEffort,
} from './llm'
import { createWorkspaceActivityProjector } from './workspace/activity'

export const DEFAULT_LLM_MODEL = 'anthropic/claude-sonnet-5.5'
export const DEFAULT_JEV_MODEL = 'jev-latest'
export const LLM_MODEL_STORAGE_KEY = 'shuttle:llmModel'

function reasoningSettingsFor(modelId: string): {
  effort: ReasoningEffort
} {
  return { effort: reasoningEffortFor(modelId) }
}

function rejectsReasoningParams(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause)
  return /reasoning|effort|unsupported|invalid.*param/i.test(message)
}

export function defaultLlmModel(env: ShuttleEnv): string {
  return env.LOOMS_MODEL?.trim() || DEFAULT_LLM_MODEL
}

export function resolveLlm(env: ShuttleEnv, storage?: DurableObjectStorage): LlmAdapter {
  const apiKey = env.OPENROUTER_API_KEY

  if (!apiKey) {
    return createStubThinkingLlm()
  }

  const openrouter = createOpenRouter({ apiKey })
  const fallback = defaultLlmModel(env)
  /** Models that rejected OpenRouter reasoning params stay on the plain chat path. */
  const plainChatModels = new Set<string>()

  return {
    complete: async (args: LlmCompleteArgs) => {
      const stored = storage ? await storage.get<string>(LLM_MODEL_STORAGE_KEY) : undefined
      const modelId = stored?.trim() || fallback

      const withReasoning = !plainChatModels.has(modelId)

      const model = withReasoning
        ? openrouter.chat(modelId, {
            reasoning: reasoningSettingsFor(modelId),
            usage: { include: true },
          })
        : openrouter.chat(modelId, {
            usage: { include: true },
          })

      const llm = createReasoningLlm({ model, stream: true })

      try {
        return await llm.complete(args)
      } catch (cause) {
        if (!withReasoning || !rejectsReasoningParams(cause)) {
          throw cause
        }

        plainChatModels.add(modelId)

        return createReasoningLlm({
          model: openrouter.chat(modelId, { usage: { include: true } }),
          stream: true,
        }).complete(args)
      }
    },
  }
}

export interface ResolvedEvaluator {
  readonly evaluator?: EvaluatorAdapter
  readonly evaluatorPolicy?: StubEvaluatorPolicy
}

/**
 * Prefer TypeSafe Jev when `TYPESAFE_AI_API_KEY` is set.
 * Without a key, fall back to local intake heuristics (no network).
 */
export function resolveEvaluator(env: ShuttleEnv): ResolvedEvaluator {
  const apiKey = env.TYPESAFE_AI_API_KEY?.trim()

  if (!apiKey) {
    return {
      evaluatorPolicy: {
        evaluate: heuristicIntakeEvaluate,
      },
    }
  }

  const model = env.JEV_MODEL?.trim() || DEFAULT_JEV_MODEL

  return {
    evaluator: vercelEvaluator({
      model,
      provider: createTypeSafeAi({ apiKey }),
    }),
  }
}

/** Offline intake fallback when TYPESAFE_AI_API_KEY is unset. */
async function heuristicIntakeEvaluate(args: EvaluatorEvaluateArgs) {
  const kind = classifyHeuristic(parseIntakeMessage(args.state))

  return {
    answers: {
      kind: { type: 'choice' as const, value: kind },
    },
    usage: { input: 0, output: 0 },
  }
}

export async function readStoredLlmModel(
  storage: DurableObjectStorage,
  env: ShuttleEnv,
): Promise<string> {
  const stored = await storage.get<string>(LLM_MODEL_STORAGE_KEY)
  return stored?.trim() || defaultLlmModel(env)
}

export async function writeStoredLlmModel(
  storage: DurableObjectStorage,
  model: string,
): Promise<string> {
  const trimmed = model.trim()

  if (!trimmed) {
    throw new Error('model is required')
  }

  await storage.put(LLM_MODEL_STORAGE_KEY, trimmed)
  return trimmed
}

export interface ProjectorContext {
  readonly runId: string
  readonly storage?: DurableObjectStorage
}

export function resolveProjectors(env: ShuttleEnv, context?: ProjectorContext): Projector[] {
  const projectors: Projector[] = []

  if (env.REPLICA) {
    projectors.push(
      sqliteReplica({
        database: d1ReplicaDatabase(env.REPLICA),
        migrate: 'auto',
        additionalFields: shuttleAttributes,
      }),
    )
  }

  if (context) {
    projectors.push(createFirehoseProjector(env, context.runId))
    projectors.push(createWorkspaceActivityProjector(env, context.runId, context.storage))
  }

  return projectors
}

export function playbookRunId(env: ShuttleEnv): string {
  return env.SHUTTLE_PLAYBOOK_RUN_ID ?? 'shuttle-playbook'
}

export function workspaceRunId(env: ShuttleEnv): string {
  return env.SHUTTLE_WORKSPACE_RUN_ID ?? 'shuttle-workspace'
}

export function pullsRunId(env: ShuttleEnv): string {
  return env.SHUTTLE_PULLS_RUN_ID ?? 'shuttle-pulls'
}

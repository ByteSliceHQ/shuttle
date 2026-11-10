import { createTypeSafeAi } from '@ai-sdk/typesafe-ai'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'

import type { LlmAdapter } from '@swirls/looms/agent'
import { vercelEvaluator, vercelLlm } from '@swirls/looms/ai-vercel'
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
import { createWorkspaceActivityProjector } from './workspace/activity'

export const DEFAULT_LLM_MODEL = 'anthropic/claude-sonnet-5.5'
export const DEFAULT_JEV_MODEL = 'jev-latest'
export const LLM_MODEL_STORAGE_KEY = 'shuttle:llmModel'

const StubLlm: LlmAdapter = {
  complete: async ({ messages }) => {
    const last = messages.toReversed().find((message) => message.role === 'user')

    const text =
      typeof last?.content === 'string'
        ? last.content
        : 'Stub LLM: set OPENROUTER_API_KEY for live model calls.'

    return {
      message: {
        role: 'assistant',
        content: `[stub] Acknowledged: ${text.slice(0, 240)}`,
      },
      done: true,
      output: { stub: true },
    }
  },
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

export function defaultLlmModel(env: ShuttleEnv): string {
  return env.LOOMS_MODEL?.trim() || DEFAULT_LLM_MODEL
}

export function resolveLlm(env: ShuttleEnv, storage?: DurableObjectStorage): LlmAdapter {
  const apiKey = env.OPENROUTER_API_KEY

  if (!apiKey) {
    return StubLlm
  }

  const openrouter = createOpenRouter({ apiKey })
  const fallback = defaultLlmModel(env)

  return {
    complete: async (args) => {
      const stored = storage ? await storage.get<string>(LLM_MODEL_STORAGE_KEY) : undefined
      const modelId = stored?.trim() || fallback
      return vercelLlm({
        model: openrouter.chat(modelId),
        stream: true,
      }).complete(args)
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

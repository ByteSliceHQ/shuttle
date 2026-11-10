import { createOpenRouter } from '@openrouter/ai-sdk-provider'

import type { LlmAdapter } from '@swirls/looms/agent'
import { vercelLlm } from '@swirls/looms/ai-vercel'
import type { Projector } from '@swirls/looms/projectors'
import { d1ReplicaDatabase, sqliteReplica } from '@swirls/looms/projectors/replica/sqlite'

import { shuttleAttributes } from './attributes'
import type { ShuttleEnv } from './env'
import { createWorkspaceActivityProjector } from './workspace/activity'

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

export function resolveLlm(env: ShuttleEnv): LlmAdapter {
  const apiKey = env.OPENROUTER_API_KEY

  if (!apiKey) {
    return StubLlm
  }

  return vercelLlm({
    model: createOpenRouter({ apiKey }).chat(env.LOOMS_MODEL ?? 'openai/gpt-4o-mini'),
    stream: true,
  })
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
    projectors.push(createWorkspaceActivityProjector(env, context.runId))
  }

  return projectors
}

export function playbookRunId(env: ShuttleEnv): string {
  return env.SHUTTLE_PLAYBOOK_RUN_ID ?? 'shuttle-playbook'
}

export function workspaceRunId(env: ShuttleEnv): string {
  return env.SHUTTLE_WORKSPACE_RUN_ID ?? 'shuttle-workspace'
}

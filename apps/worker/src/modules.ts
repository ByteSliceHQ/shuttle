import { agent } from '@swirls/looms/agent'
import { approval } from '@swirls/looms/approval'
import { evaluator } from '@swirls/looms/evaluator'

import { createConductorAgent } from './agents/conductor'
import { intake } from './agents/intake'
import { createNarratorAgent } from './agents/narrator'
import { createReflectorAgent } from './agents/reflector'
import { createReviewerAgent } from './agents/reviewer'
import { createWorkerAgent } from './agents/worker'
import { resolveEvaluator, resolveLlm } from './config'
import type { ShuttleEnv } from './env'
import { pulls } from './pulls/module'
import { reflect } from './reflect/module'
import { codingSession, reviewSession, shuttleSession } from './session/module'
import { workspace } from './workspace/module'

export interface ShuttleModulesOptions {
  readonly storage?: DurableObjectStorage
}

/**
 * Compose native Looms modules with Shuttle's custom session, reflect, pulls, and workspace modules.
 * This is the demo's showcase of custom module interoperability.
 */
export function shuttleModules(
  env: ShuttleEnv,
  runId: string,
  options: ShuttleModulesOptions = {},
) {
  const storage = options.storage
  const llm = resolveLlm(env, storage, runId)
  const { evaluator: evaluatorAdapter, evaluatorPolicy } = resolveEvaluator(env)
  const conductor = createConductorAgent(env, runId, storage)
  const worker = createWorkerAgent(env, runId, storage)
  const narrator = createNarratorAgent(env, runId, storage)
  const reflector = createReflectorAgent(env, runId)
  const reviewer = createReviewerAgent(env, runId, storage)

  return [
    agent({
      definitions: [conductor, worker, narrator, reflector, reviewer],
      llm,
    }),
    evaluator({
      definitions: [intake],
      evaluator: evaluatorAdapter,
      evaluatorPolicy,
    }),
    approval(),
    shuttleSession({ definitions: [codingSession, reviewSession], storage, env }),
    reflect(),
    pulls({ env }),
    workspace(),
  ]
}

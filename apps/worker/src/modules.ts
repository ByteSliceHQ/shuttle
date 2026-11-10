import { agent } from '@swirls/looms/agent'
import { approval } from '@swirls/looms/approval'
import { evaluator } from '@swirls/looms/evaluator'

import { createConductorAgent } from './agents/conductor'
import { intake } from './agents/intake'
import { createNarratorAgent } from './agents/narrator'
import { createReflectorAgent } from './agents/reflector'
import { createWorkerAgent } from './agents/worker'
import { resolveLlm } from './config'
import type { ShuttleEnv } from './env'
import { reflect } from './reflect/module'
import { codingSession, shuttleSession } from './session/module'

/**
 * Compose native Looms modules with Shuttle's custom session + reflect modules.
 * This is the demo's showcase of custom module interoperability.
 */
export function shuttleModules(env: ShuttleEnv, runId: string) {
  const llm = resolveLlm(env)
  const conductor = createConductorAgent(env, runId)
  const worker = createWorkerAgent(env, runId)
  const narrator = createNarratorAgent(env, runId)
  const reflector = createReflectorAgent(env, runId)

  return [
    agent({
      definitions: [conductor, worker, narrator, reflector],
      llm,
    }),
    evaluator({ definitions: [intake] }),
    approval(),
    shuttleSession({ definitions: [codingSession] }),
    reflect(),
  ]
}

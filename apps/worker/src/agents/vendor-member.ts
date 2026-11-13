import { z } from 'zod'

import { defineAgent } from '@swirls/looms/agent'

import type { VendorHarnessId } from '../harness'
import { vendorHarnessInfo } from '../vendor/harnesses'

/** The `model` that sends an agent's turns to a vendor agent instead of a model. */
export function vendorModel(harness: VendorHarnessId): string {
  return `vendor:${harness}`
}

/** The harness a `model` names, or null for an ordinary model id. */
export function vendorHarnessOfModel(model: string | undefined): VendorHarnessId | null {
  if (!model?.startsWith('vendor:')) {
    return null
  }

  const harness = model.slice('vendor:'.length)

  return harness === 'codex' || harness === 'claude-code' ? harness : null
}

/**
 * A vendor agent (Codex, Claude Code) as a member of the session's team. The conductor delegates
 * to it the way it does to a worker; each of its turns runs on the vendor agent in the sandbox,
 * which does its own planning and tool use and replies with what it did.
 */
export function createVendorMemberAgent(harness: 'codex' | 'claude-code') {
  const label = vendorHarnessInfo(harness).label

  return defineAgent({
    name: harness,
    description: `${label}, working in the shared session worktree on the developer's own subscription`,
    model: vendorModel(harness),
    conversational: false,
    maxTurns: 3,
    input: z.object({
      text: z.string().describe('Task from the conductor'),
    }),
    instructions: `You are ${label}, a member of this Shuttle session's team.`,
    tools: [],
  })
}

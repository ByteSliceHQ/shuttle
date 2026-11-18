import { z } from 'zod'

export const BUILT_IN_HARNESSES = ['shuttle', 'codex', 'claude-code', 'cursor'] as const

export const BuiltInHarness = z.enum(BUILT_IN_HARNESSES)
export type BuiltInHarness = z.infer<typeof BuiltInHarness>

/** An agent reached over the Agent Client Protocol, named by the deployment. */
export const AcpHarness = z.templateLiteral(['acp:', z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/)])
export type AcpHarness = z.infer<typeof AcpHarness>

/**
 * Which agent runs a session. `shuttle` is the Looms loop on OpenRouter; every other harness is a
 * vendor agent that runs in the sandbox under the developer's own subscription.
 */
export const HarnessId = z.union([BuiltInHarness, AcpHarness])
export type HarnessId = z.infer<typeof HarnessId>

export type VendorHarnessId = Exclude<HarnessId, 'shuttle'>

export const SessionHarness = z.object({ harness: HarnessId })
export type SessionHarness = z.infer<typeof SessionHarness>

export const TEAM_PRESETS = [
  'none',
  'codex-builds-claude-reviews',
  'claude-builds-codex-reviews',
  'claude-plans-codex-implements',
] as const

export const TeamPreset = z.enum(TEAM_PRESETS)
export type TeamPreset = z.infer<typeof TeamPreset>

/** Who Shuttle's conductor may hand work to in a session. */
export const Team = z.object({
  /** Shuttle's own workers, on OpenRouter. */
  workers: z.boolean(),
  codex: z.boolean(),
  claudeCode: z.boolean(),
  cursor: z.boolean(),
  /** Standing roles for the agents, or `none` to let the conductor decide. */
  preset: TeamPreset,
})
export type Team = z.infer<typeof Team>

export const SessionTeam = z.object({ team: Team })
export type SessionTeam = z.infer<typeof SessionTeam>

/** A model a vendor agent offers under the developer's own subscription. */
export const VendorModel = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  /** Reasoning efforts the model accepts, lowest first. Empty when it takes none. */
  efforts: z.array(z.string()).readonly(),
  defaultEffort: z.string().optional(),
  /** True for the model the agent uses when none is chosen. */
  isDefault: z.boolean().optional(),
})
export type VendorModel = z.infer<typeof VendorModel>

/** Either part may be absent, which leaves that part to the agent's own default. */
export const VendorModelChoice = z.object({
  model: z.string().optional(),
  effort: z.string().optional(),
})
export type VendorModelChoice = z.infer<typeof VendorModelChoice>

export const VendorModelChoices = z.partialRecord(z.string(), VendorModelChoice)
export type VendorModelChoices = Partial<Record<VendorHarnessId, VendorModelChoice>>

export const SessionVendorModels = z.object({ choices: VendorModelChoices })

import type { HarnessId, Team, VendorHarnessId, VendorModel, VendorModelChoice } from './api'

/**
 * Whose models the picker offers. `openrouter` is Shuttle's own loop (the conductor and its
 * workers); the others are vendor agents, which run on the developer's subscription.
 */
export type ModelSection = 'openrouter' | VendorHarnessId

export const SECTION_LABELS: Record<ModelSection, string> = {
  openrouter: 'Shuttle',
  codex: 'Codex',
  'claude-code': 'Claude Code',
}

/**
 * The sections that matter for a session: the one agent running it, or, for a Shuttle session,
 * Shuttle's own models followed by each vendor agent on its team.
 */
export function modelSections(harness: HarnessId, team: Team): ModelSection[] {
  if (harness !== 'shuttle') {
    return [harness]
  }

  return [
    'openrouter',
    ...(team.codex ? (['codex'] as const) : []),
    ...(team.claudeCode ? (['claude-code'] as const) : []),
  ]
}

const EFFORT_LABELS: Record<string, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
  ultra: 'Ultra',
}

export function effortLabel(effort: string): string {
  return EFFORT_LABELS[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1)
}

/** The model a choice runs on: the chosen one, else the one the agent uses by default. */
export function chosenVendorModel(
  choice: VendorModelChoice | undefined,
  models: readonly VendorModel[],
): VendorModel | undefined {
  return choice?.model
    ? models.find((model) => model.id === choice.model)
    : models.find((model) => model.isDefault)
}

/** Short text for a choice, such as "GPT-6.1-Sol · High". */
export function vendorChoiceLabel(
  choice: VendorModelChoice | undefined,
  models: readonly VendorModel[],
): string {
  const model = chosenVendorModel(choice, models)
  const name = model?.label ?? choice?.model ?? 'Default model'

  return choice?.effort ? `${name} · ${effortLabel(choice.effort)}` : name
}

/** Moves a choice to another model, keeping the effort only when the new model accepts it. */
export function withVendorModel(
  choice: VendorModelChoice | undefined,
  model: VendorModel | undefined,
  defaultModel: VendorModel | undefined,
): VendorModelChoice {
  const efforts = (model ?? defaultModel)?.efforts ?? []
  const effort = choice?.effort && efforts.includes(choice.effort) ? choice.effort : undefined

  return { ...(model ? { model: model.id } : {}), ...(effort ? { effort } : {}) }
}

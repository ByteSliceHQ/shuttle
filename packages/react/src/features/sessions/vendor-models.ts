import type {
  BuiltInHarness,
  HarnessId,
  Team,
  VendorHarnessId,
  VendorModel,
  VendorModelChoice,
} from '@shuttle/api'

/**
 * Whose models the picker offers. `openrouter` is Shuttle's own loop (the conductor and its
 * workers); the others are vendor agents, which run on the developer's subscription.
 */
export type ModelSection = 'openrouter' | VendorHarnessId

const BUILT_IN_LABELS: Record<'openrouter' | Exclude<BuiltInHarness, 'shuttle'>, string> = {
  openrouter: 'Shuttle',
  codex: 'Codex',
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
}

function isBuiltInSection(section: ModelSection): section is keyof typeof BUILT_IN_LABELS {
  return section in BUILT_IN_LABELS
}

/**
 * What to call a section. An agent reached over the Agent Client Protocol has no name of its own
 * here, so it goes by the one its deployment gave it: `acp:gemini` reads as "gemini".
 */
export function sectionLabel(section: ModelSection): string {
  return isBuiltInSection(section) ? BUILT_IN_LABELS[section] : section.replace(/^acp:/, '')
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
    ...(team.cursor ? (['cursor'] as const) : []),
  ]
}

const EFFORT_LABELS = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
  ultra: 'Ultra',
} satisfies Record<string, string>

function isKnownEffort(effort: string): effort is keyof typeof EFFORT_LABELS {
  return Object.hasOwn(EFFORT_LABELS, effort)
}

export function effortLabel(effort: string): string {
  return isKnownEffort(effort)
    ? EFFORT_LABELS[effort]
    : effort.charAt(0).toUpperCase() + effort.slice(1)
}

/** The model a choice names, or `undefined` when it leaves the choice to the agent's default. */
export function chosenModelId(choice: VendorModelChoice | undefined): string | undefined {
  return choice?.model === undefined || choice.model === '' ? undefined : choice.model
}

/** The reasoning effort a choice names, or `undefined` when it leaves it to the model. */
export function chosenEffort(choice: VendorModelChoice | undefined): string | undefined {
  return choice?.effort === undefined || choice.effort === '' ? undefined : choice.effort
}

/** The model a choice runs on: the chosen one, else the one the agent uses by default. */
export function chosenVendorModel(
  choice: VendorModelChoice | undefined,
  models: readonly VendorModel[],
): VendorModel | undefined {
  return chosenModelId(choice) === undefined
    ? models.find((model) => model.isDefault === true)
    : models.find((model) => model.id === choice?.model)
}

/** Short text for a choice, such as "GPT-6.1-Sol · High". */
export function vendorChoiceLabel(
  choice: VendorModelChoice | undefined,
  models: readonly VendorModel[],
): string {
  const model = chosenVendorModel(choice, models)
  const name = model?.label ?? choice?.model ?? 'Default model'

  const effort = chosenEffort(choice)

  return effort === undefined ? name : `${name} · ${effortLabel(effort)}`
}

/** Moves a choice to another model, keeping the effort only when the new model accepts it. */
export function withVendorModel(
  choice: VendorModelChoice | undefined,
  model: VendorModel | undefined,
  defaultModel: VendorModel | undefined,
): VendorModelChoice {
  const efforts = (model ?? defaultModel)?.efforts ?? []
  const kept = chosenEffort(choice)
  const effort = kept !== undefined && efforts.includes(kept) ? kept : undefined

  if (model === undefined) {
    return effort === undefined ? {} : { effort }
  }

  return effort === undefined ? { model: model.id } : { model: model.id, effort }
}

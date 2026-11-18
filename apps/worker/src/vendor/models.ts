import { z } from 'zod'

import type { BridgeModel } from '../../bridge/protocol'
import type { VendorHarnessId } from '../harness'

/**
 * Model choice for vendor agents. Each agent runs on the developer's own subscription, so the
 * models on offer are the agent's, not OpenRouter's. A choice is kept per session and per agent;
 * the workspace run keeps the most recent one as the starting point for new sessions.
 */

export type VendorModel = BridgeModel

/** Either part may be absent, which leaves that part to the agent's own default. */
export interface VendorModelChoice {
  readonly model?: string
  readonly effort?: string
}

export type VendorModelChoices = Partial<Record<VendorHarnessId, VendorModelChoice>>

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,79}$/
const EFFORT = /^[a-z]{1,16}$/

const choiceKey = (harness: VendorHarnessId) => `shuttle:vendorModel:${harness}`
const catalogueKey = (harness: VendorHarnessId) => `shuttle:vendorModels:${harness}`

/** How long a model list fetched from an agent is trusted before it is fetched again. */
export const CATALOGUE_TTL_MS = 24 * 60 * 60 * 1000

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * Claude Code has no command that lists its models, so these are its documented aliases. An
 * alias always resolves to the newest model of that class the subscription can use.
 */
const CLAUDE_MODELS: readonly VendorModel[] = [
  {
    id: 'fable',
    label: 'Claude Fable',
    description: 'The most capable Claude model, for the hardest work.',
    efforts: CLAUDE_EFFORTS,
  },
  {
    id: 'opus',
    label: 'Claude Opus',
    description: 'A large model for difficult, long-running tasks.',
    efforts: CLAUDE_EFFORTS,
  },
  {
    id: 'sonnet',
    label: 'Claude Sonnet',
    description: 'Balanced quality and speed for everyday coding.',
    efforts: CLAUDE_EFFORTS,
  },
  {
    id: 'haiku',
    label: 'Claude Haiku',
    description: 'The fastest model, for small and simple tasks.',
    efforts: [],
  },
]

const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const

/**
 * Shown for Codex only when its own list cannot be fetched (no container, or an older sandbox
 * image). Codex's list is the source of truth; see `listCodexModels` in the bridge.
 */
const CODEX_FALLBACK_MODELS: readonly VendorModel[] = [
  {
    id: 'gpt-6.1-sol',
    label: 'GPT-6.1-Sol',
    description: 'Latest workhorse model for coding and everyday work.',
    efforts: CODEX_EFFORTS,
    defaultEffort: 'low',
    isDefault: true,
  },
  {
    id: 'gpt-6-astra',
    label: 'GPT-6-Astra',
    description: 'Frontier intelligence for the most demanding work.',
    efforts: CODEX_EFFORTS,
    defaultEffort: 'low',
  },
  {
    id: 'gpt-6-luna',
    label: 'GPT-6-Luna',
    description: 'Fast and affordable model for easier tasks.',
    efforts: CODEX_EFFORTS,
    defaultEffort: 'medium',
  },
]

/**
 * Shown for Cursor only when its own list cannot be fetched. Cursor's list is the source of
 * truth; see `listCursorModels` in the bridge.
 */
const CURSOR_FALLBACK_MODELS: readonly VendorModel[] = [
  {
    id: 'composer-2.5',
    label: 'Composer 2.5',
    description: "Cursor's coding model for everyday agent work.",
    efforts: [],
    isDefault: true,
  },
  {
    id: 'auto',
    label: 'Auto',
    description: 'Lets Cursor pick a model for the task.',
    efforts: [],
  },
]

/** The models to offer when the agent cannot be asked for its own list. */
export function builtInVendorModels(harness: VendorHarnessId): readonly VendorModel[] {
  if (harness === 'claude-code') {
    return CLAUDE_MODELS
  }

  if (harness === 'codex') {
    return CODEX_FALLBACK_MODELS
  }

  return harness === 'cursor' ? CURSOR_FALLBACK_MODELS : []
}

/** Whether the agent can report its own models, which then replace the built-in list. */
export function listsOwnModels(harness: VendorHarnessId): boolean {
  return harness === 'codex' || harness === 'cursor'
}

/** A choice as a caller may state it. Either part may be absent or blank. */
export interface VendorModelChoiceInput {
  readonly model?: string
  readonly effort?: string
}

/** Blank parts are dropped, so `{}` means "the agent's defaults". Malformed parts reject it. */
const VendorModelChoiceSchema = z
  .object({
    model: z.string().trim().catch(''),
    effort: z.string().trim().catch(''),
  })
  .refine(
    ({ model, effort }) =>
      (model === '' || MODEL_ID.test(model)) && (effort === '' || EFFORT.test(effort)),
  )
  .transform(({ model, effort }): VendorModelChoice => {
    if (model !== '' && effort !== '') {
      return { model, effort }
    }

    if (model !== '') {
      return { model }
    }

    return effort === '' ? {} : { effort }
  })

/** A valid choice, or null. Blank parts are dropped, so `{}` means "the agent's defaults". */
export function parseVendorModelChoice(
  value: VendorModelChoiceInput | null,
): VendorModelChoice | null {
  return VendorModelChoiceSchema.safeParse(value).data ?? null
}

const EffortSchema = z.string().regex(EFFORT)

/** One model from an agent's own list; a field that is the wrong type falls back to blank. */
const VendorModelSchema = z
  .object({
    id: z.string().regex(MODEL_ID),
    label: z.string().catch(''),
    description: z.string().catch(''),
    efforts: z
      .array(z.unknown())
      .catch([])
      .transform((items) =>
        items.flatMap((item) => {
          const effort = EffortSchema.safeParse(item)

          return effort.success ? [effort.data] : []
        }),
      ),
    defaultEffort: z.string().optional().catch(undefined),
    isDefault: z.boolean().catch(false),
  })
  .transform(({ id, label, description, efforts, defaultEffort, isDefault }): VendorModel => {
    const base = { id, label: label === '' ? id : label, description, efforts }

    const withEffort =
      defaultEffort !== undefined && efforts.includes(defaultEffort)
        ? { ...base, defaultEffort }
        : base

    return isDefault ? { ...withEffort, isDefault: true } : withEffort
  })

/** Keeps only well-formed models from an agent's own list. */
export function parseVendorModels(value: { readonly models: readonly unknown[] }): VendorModel[] {
  return value.models.flatMap((entry) => {
    const model = VendorModelSchema.safeParse(entry)

    return model.success ? [model.data] : []
  })
}

const StoredCatalogueSchema = z.object({
  models: z.array(z.unknown()).catch([]),
  fetchedAt: z.number(),
})

type ModelStorage = Pick<DurableObjectStorage, 'get' | 'put'>

/** The choice stored on this run for `harness`, or null when none has been made on it. */
export async function readVendorModelChoice(
  storage: Pick<DurableObjectStorage, 'get'>,
  harness: VendorHarnessId,
): Promise<VendorModelChoice | null> {
  return VendorModelChoiceSchema.safeParse(await storage.get(choiceKey(harness))).data ?? null
}

export async function writeVendorModelChoice(
  storage: ModelStorage,
  harness: VendorHarnessId,
  value: VendorModelChoiceInput | null,
): Promise<VendorModelChoice> {
  const choice = parseVendorModelChoice(value)

  if (choice === null) {
    throw new Error('invalid model choice')
  }

  await storage.put(choiceKey(harness), choice)
  return choice
}

export interface VendorCatalogue {
  readonly models: readonly VendorModel[]
  readonly fetchedAt: number
}

export async function readVendorCatalogue(
  storage: Pick<DurableObjectStorage, 'get'>,
  harness: VendorHarnessId,
): Promise<VendorCatalogue | null> {
  const stored = StoredCatalogueSchema.safeParse(await storage.get(catalogueKey(harness)))

  if (!stored.success) {
    return null
  }

  const models = parseVendorModels(stored.data)

  return models.length > 0 ? { models, fetchedAt: stored.data.fetchedAt } : null
}

export async function writeVendorCatalogue(
  storage: ModelStorage,
  harness: VendorHarnessId,
  models: readonly VendorModel[],
  now = Date.now(),
): Promise<VendorCatalogue> {
  const catalogue = { models: parseVendorModels({ models }), fetchedAt: now }

  await storage.put(catalogueKey(harness), catalogue)
  return catalogue
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A valid choice, or null. Blank parts are dropped, so `{}` means "the agent's defaults". */
export function parseVendorModelChoice(value: unknown): VendorModelChoice | null {
  if (!isRecord(value)) {
    return null
  }

  const model = typeof value.model === 'string' ? value.model.trim() : ''
  const effort = typeof value.effort === 'string' ? value.effort.trim() : ''

  if ((model && !MODEL_ID.test(model)) || (effort && !EFFORT.test(effort))) {
    return null
  }

  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
}

/** Keeps only well-formed models from an agent's own list. */
export function parseVendorModels(value: unknown): VendorModel[] {
  const entries = isRecord(value) && Array.isArray(value.models) ? value.models : []

  return entries.flatMap((entry): VendorModel[] => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !MODEL_ID.test(entry.id)) {
      return []
    }

    const efforts = Array.isArray(entry.efforts)
      ? entry.efforts.filter(
          (effort): effort is string => typeof effort === 'string' && EFFORT.test(effort),
        )
      : []

    return [
      {
        id: entry.id,
        label: typeof entry.label === 'string' && entry.label ? entry.label : entry.id,
        description: typeof entry.description === 'string' ? entry.description : '',
        efforts,
        ...(typeof entry.defaultEffort === 'string' && efforts.includes(entry.defaultEffort)
          ? { defaultEffort: entry.defaultEffort }
          : {}),
        ...(entry.isDefault === true ? { isDefault: true } : {}),
      },
    ]
  })
}

type ModelStorage = Pick<DurableObjectStorage, 'get' | 'put'>

/** The choice stored on this run for `harness`, or null when none has been made on it. */
export async function readVendorModelChoice(
  storage: Pick<DurableObjectStorage, 'get'>,
  harness: VendorHarnessId,
): Promise<VendorModelChoice | null> {
  return parseVendorModelChoice(await storage.get(choiceKey(harness)))
}

export async function writeVendorModelChoice(
  storage: ModelStorage,
  harness: VendorHarnessId,
  value: unknown,
): Promise<VendorModelChoice> {
  const choice = parseVendorModelChoice(value)

  if (!choice) {
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
  const stored = await storage.get<{ models?: unknown; fetchedAt?: unknown }>(catalogueKey(harness))
  const models = parseVendorModels(stored)

  return models.length > 0 && typeof stored?.fetchedAt === 'number'
    ? { models, fetchedAt: stored.fetchedAt }
    : null
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

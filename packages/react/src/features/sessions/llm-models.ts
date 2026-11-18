const STORAGE_KEY = 'shuttle.llm-model'

export type ModelTag = 'high' | 'medium' | 'fast'

export type ModelGroup = 'frontier' | 'fast'

export interface OpenRouterModel {
  readonly id: string
  readonly label: string
  readonly group: ModelGroup
  readonly tags: readonly ModelTag[]
  /** One-line pitch shown in the hover detail panel. */
  readonly description: string
  /** Context window in tokens. */
  readonly context: number
  /** Optional italic footnote (e.g. effort / version note). */
  readonly note?: string
}

/**
 * Curated OpenRouter chat models for the session switcher.
 * Ordered frontier-first within each group; keep IDs in sync with openrouter.ai.
 */
export const OPENROUTER_MODELS = [
  {
    id: 'anthropic/claude-fable-5.2',
    label: 'Claude Fable 5.2',
    group: 'frontier',
    tags: ['high'],
    description: "Anthropic's most capable model for demanding technical and agentic work.",
    context: 1_000_000,
    note: 'Flagship',
  },
  {
    id: 'anthropic/claude-opus-5.5',
    label: 'Claude Opus 5.5',
    group: 'frontier',
    tags: ['high'],
    description: "Anthropic's large model class, great for difficult agentic tasks.",
    context: 1_000_000,
    note: 'High effort',
  },
  {
    id: 'openai/gpt-6-astra',
    label: 'GPT-6 Astra',
    group: 'frontier',
    tags: ['high'],
    description: "OpenAI's flagship for deep analysis, coding, and long-horizon work.",
    context: 1_050_000,
    note: 'Flagship',
  },
  {
    id: 'google/gemini-4-argon',
    label: 'Gemini 4 Argon',
    group: 'frontier',
    tags: ['high'],
    description: "Google's flagship reasoning model for complex engineering and agents.",
    context: 1_048_576,
    note: 'Flagship',
  },
  {
    id: 'x-ai/grok-4.7',
    label: 'Grok 4.7',
    group: 'frontier',
    tags: ['high', 'fast'],
    description: 'Strong at long-running software engineering and self-verification.',
    context: 500_000,
  },
  {
    id: 'openai/gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    group: 'frontier',
    tags: ['medium'],
    description: 'Balanced GPT-5.6 flagship for coding and multi-step agent workflows.',
    context: 1_050_000,
  },
  {
    id: 'meta/muse-wonder',
    label: 'Muse Wonder',
    group: 'frontier',
    tags: ['high'],
    description: "Meta's frontier multimodal model for complex agentic tasks.",
    context: 1_048_576,
  },
  {
    id: 'anthropic/claude-sonnet-5.5',
    label: 'Claude Sonnet 5.5',
    group: 'frontier',
    tags: ['high', 'fast'],
    description: 'Balanced quality and speed, recommended for most session work.',
    context: 1_000_000,
    note: 'Recommended',
  },
  {
    id: 'google/gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    group: 'fast',
    tags: ['fast'],
    description: "Google's smartest Flash model — strong speed/quality tradeoff.",
    context: 1_048_576,
  },
  {
    id: 'openai/gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    group: 'fast',
    tags: ['fast'],
    description: 'Fast, cost-efficient GPT for latency-sensitive agent turns.',
    context: 1_050_000,
  },
  {
    id: 'anthropic/claude-haiku-5.5',
    label: 'Claude Haiku 5.5',
    group: 'fast',
    tags: ['fast'],
    description: 'Small and quick — good for high-volume or lightweight turns.',
    context: 1_000_000,
  },
  {
    id: 'deepseek/deepseek-v4.1-flash',
    label: 'DeepSeek V4.1 Flash',
    group: 'fast',
    tags: ['fast'],
    description: 'Fast open MoE model with a large context window.',
    context: 1_048_576,
  },
  {
    id: 'x-ai/grok-4.6',
    label: 'Grok 4.6',
    group: 'fast',
    tags: ['high', 'fast'],
    description: 'Previous Grok flagship — still strong on coding and STEM.',
    context: 500_000,
  },
] as const satisfies readonly OpenRouterModel[]

export type OpenRouterModelId = (typeof OPENROUTER_MODELS)[number]['id']

export const DEFAULT_OPENROUTER_MODEL: OpenRouterModelId = 'anthropic/claude-sonnet-5.5'

export const MODEL_GROUP_LABELS: Record<ModelGroup, string> = {
  frontier: 'Frontier',
  fast: 'Fast',
}

export const MODEL_TAG_LABELS: Record<ModelTag, string> = {
  high: 'High',
  medium: 'Medium',
  fast: 'Fast',
}

/** Soft tint per tag — matches the app's status/route color language. */
export const MODEL_TAG_TONES: Record<ModelTag, string> = {
  high: 'text-status-running bg-status-running/12',
  medium: 'text-status-waiting bg-status-waiting/12',
  fast: 'text-status-completed bg-status-completed/12',
}

export function isOpenRouterModelId(value: string): value is OpenRouterModelId {
  return OPENROUTER_MODELS.some((model) => model.id === value)
}

export function getOpenRouterModel(modelId: string): OpenRouterModel | undefined {
  return OPENROUTER_MODELS.find((model) => model.id === modelId)
}

export function readStoredLlmModel(): OpenRouterModelId {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)?.trim()
    return stored !== undefined && isOpenRouterModelId(stored) ? stored : DEFAULT_OPENROUTER_MODEL
  } catch {
    return DEFAULT_OPENROUTER_MODEL
  }
}

export function writeStoredLlmModel(model: OpenRouterModelId) {
  try {
    localStorage.setItem(STORAGE_KEY, model)
  } catch {
    // ignore quota / private mode
  }
}

export function modelLabel(modelId: string): string {
  return getOpenRouterModel(modelId)?.label ?? modelId
}

export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000

    const rounded = Number.isInteger(millions)
      ? String(millions)
      : millions.toFixed(2).replace(/0+$/, '')

    return `${rounded}M context`
  }

  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}k context`
  }

  return `${tokens} context`
}

export function modelsByGroup(group: ModelGroup): readonly OpenRouterModel[] {
  return OPENROUTER_MODELS.filter((model) => model.group === group)
}

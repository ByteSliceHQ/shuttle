/**
 * Which agent runs a session. `shuttle` is the Looms loop on OpenRouter; every other harness is a
 * vendor agent that runs inside the sandbox container under the developer's own subscription.
 */
export const BUILT_IN_HARNESSES = ['shuttle', 'codex', 'claude-code', 'cursor'] as const

export type BuiltInHarness = (typeof BUILT_IN_HARNESSES)[number]
export type AcpHarness = `acp:${string}`
export type HarnessId = BuiltInHarness | AcpHarness
export type VendorHarnessId = Exclude<HarnessId, 'shuttle'>

export const DEFAULT_HARNESS: HarnessId = 'shuttle'
export const HARNESS_STORAGE_KEY = 'shuttle:harness'

const ACP_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/

function isBuiltIn(value: string): value is BuiltInHarness {
  return (BUILT_IN_HARNESSES as readonly string[]).includes(value)
}

/** The harness id for `value`, or null when it is not one Shuttle knows how to run. */
export function parseHarness(value: unknown): HarnessId | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()

  if (isBuiltIn(trimmed)) {
    return trimmed
  }

  if (trimmed.startsWith('acp:') && ACP_NAME.test(trimmed.slice(4))) {
    return trimmed as AcpHarness
  }

  return null
}

export function isVendorHarness(harness: HarnessId): harness is VendorHarnessId {
  return harness !== 'shuttle'
}

type HarnessStorage = Pick<DurableObjectStorage, 'get' | 'put'>

/** The harness set on this run, or null when none has been chosen for it yet. */
export async function readPinnedHarness(storage: HarnessStorage): Promise<HarnessId | null> {
  return parseHarness(await storage.get<string>(HARNESS_STORAGE_KEY))
}

export async function readStoredHarness(storage: HarnessStorage): Promise<HarnessId> {
  return parseHarness(await storage.get<string>(HARNESS_STORAGE_KEY)) ?? DEFAULT_HARNESS
}

export async function writeStoredHarness(
  storage: HarnessStorage,
  value: unknown,
): Promise<HarnessId> {
  const harness = parseHarness(value)

  if (!harness) {
    throw new Error('unknown harness')
  }

  await storage.put(HARNESS_STORAGE_KEY, harness)
  return harness
}

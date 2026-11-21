import { z } from 'zod'

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
  return BUILT_IN_HARNESSES.some((harness) => harness === value)
}

function isAcpHarness(value: string): value is AcpHarness {
  return value.startsWith('acp:') && ACP_NAME.test(value.slice(4))
}

/** The harness id for `value`, or null when it is not one Shuttle knows how to run. */
export function parseHarness(value: string | undefined): HarnessId | null {
  if (value === undefined) {
    return null
  }

  const trimmed = value.trim()

  if (isBuiltIn(trimmed)) {
    return trimmed
  }

  if (isAcpHarness(trimmed)) {
    return trimmed
  }

  return null
}

export function isVendorHarness(harness: HarnessId): harness is VendorHarnessId {
  return harness !== 'shuttle'
}

type HarnessStorage = Pick<DurableObjectStorage, 'get' | 'put'>

async function readHarnessValue(storage: HarnessStorage): Promise<string | undefined> {
  return z.string().safeParse(await storage.get(HARNESS_STORAGE_KEY)).data
}

/** The harness set on this run, or null when none has been chosen for it yet. */
export async function readPinnedHarness(storage: HarnessStorage): Promise<HarnessId | null> {
  return parseHarness(await readHarnessValue(storage))
}

export async function readStoredHarness(storage: HarnessStorage): Promise<HarnessId> {
  return parseHarness(await readHarnessValue(storage)) ?? DEFAULT_HARNESS
}

export async function writeStoredHarness(
  storage: HarnessStorage,
  value: string,
): Promise<HarnessId> {
  const harness = parseHarness(value)

  if (harness === null) {
    throw new Error('unknown harness')
  }

  await storage.put(HARNESS_STORAGE_KEY, harness)
  return harness
}

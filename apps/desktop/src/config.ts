import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * What a packaged app is built to use: the Shuttle deployment its window opens, and the sandbox
 * image its runner pulls. Written beside the app's resources when it is packaged (see
 * `scripts/package.ts`). Neither is a secret; an app carries none.
 */
export interface PackagedConfig {
  readonly autoUpdate?: boolean
  readonly url?: string
  readonly image?: string
}

export const PACKAGED_CONFIG_FILE = 'desktop.config.json'

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Empty when the app is run from the repository, where no such file exists. */
export function readPackagedConfig(resourcesPath: string): PackagedConfig {
  try {
    const parsed = JSON.parse(
      readFileSync(join(resourcesPath, PACKAGED_CONFIG_FILE), 'utf8'),
    ) as Record<string, unknown>

    const url = text(parsed.url)
    const image = text(parsed.image)

    return {
      autoUpdate: parsed.autoUpdate === true,
      ...(url ? { url } : {}),
      ...(image ? { image } : {}),
    }
  } catch {
    return {}
  }
}

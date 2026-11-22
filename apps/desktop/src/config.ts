import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { z } from 'zod'

import { nonEmpty } from './text'

/**
 * What a packaged app is built to use: the Shuttle deployment its window opens, and the sandbox
 * image its runner pulls. Written beside the app's resources when it is packaged (see
 * `scripts/package.ts`). Neither is a secret; an app carries none.
 */
export interface PackagedConfig {
  readonly autoUpdate?: boolean
  readonly url?: string
  readonly image?: string
  /** The commit the app was built from, seven characters. Shown in About Shuttle. */
  readonly commit?: string
}

export const PACKAGED_CONFIG_FILE = 'desktop.config.json'

/** A string, trimmed. Anything else counts as not given. */
const textSchema = z.string().trim().catch('')

const packagedConfigSchema = z.object({
  autoUpdate: z.boolean().catch(false),
  url: textSchema,
  image: textSchema,
  commit: textSchema,
})

/** Empty when the app is run from the repository, where no such file exists. */
export function readPackagedConfig(resourcesPath: string): PackagedConfig {
  try {
    const { autoUpdate, url, image, commit } = packagedConfigSchema.parse(
      JSON.parse(readFileSync(join(resourcesPath, PACKAGED_CONFIG_FILE), 'utf8')),
    )

    return {
      autoUpdate,
      url: nonEmpty(url),
      image: nonEmpty(image),
      commit: nonEmpty(commit.slice(0, 7)),
    }
  } catch {
    return {}
  }
}

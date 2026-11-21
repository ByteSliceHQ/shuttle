import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, sep } from 'node:path'

import { isJsonObject, isString, type JsonValue } from './json'

/**
 * Moves an agent's sign-in files in and out of its home directory. The container disk does not
 * survive a restart, so the Worker seeds these before a run and collects them after, because
 * agents refresh their tokens in place.
 */

/** The absolute path for `relative` under `home`. Throws if it would land outside `home`. */
export function resolveHomePath(home: string, relative: string): string {
  const cleaned = normalize(relative)

  if (!relative || isAbsolute(relative) || cleaned === '..' || cleaned.startsWith(`..${sep}`)) {
    throw new Error(`refusing path outside the home directory: ${relative}`)
  }

  return join(home, cleaned)
}

/** Base64 file contents, keyed by path relative to the home directory. */
export interface HomeFiles {
  readonly [relative: string]: string
}

/** The files `seed` was given as JSON on stdin. Throws when it is not an object of base64 text. */
export function decodeHomeFiles(value: JsonValue | undefined): HomeFiles {
  if (!isJsonObject(value)) {
    throw new Error('seed expects a JSON object of base64 files keyed by path')
  }

  const files: { [relative: string]: string } = {}

  for (const [relative, base64] of Object.entries(value)) {
    if (!isString(base64)) {
      throw new Error(`seed expects base64 text for ${relative}`)
    }

    files[relative] = base64
  }

  return files
}

/** Writes base64 `files`, keyed by home-relative path, readable only by the owner. */
export function seedHomeFiles(home: string, files: HomeFiles): void {
  for (const [relative, base64] of Object.entries(files)) {
    const path = resolveHomePath(home, relative)

    const bytes = Uint8Array.from(atob(base64), (char) => char.codePointAt(0) ?? 0)

    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, bytes, { mode: 0o600 })
    chmodSync(path, 0o600)
  }
}

/** Reads the files that exist among `paths`, as base64 keyed by home-relative path. */
export function collectHomeFiles(home: string, paths: readonly string[]): HomeFiles {
  const files: { [relative: string]: string } = {}

  for (const relative of paths) {
    const path = resolveHomePath(home, relative)

    if (existsSync(path)) {
      files[relative] = readFileSync(path).toString('base64')
    }
  }

  return files
}

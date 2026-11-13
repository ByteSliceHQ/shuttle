import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, sep } from 'node:path'

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

/** Writes base64 `files`, keyed by home-relative path, readable only by the owner. */
export function seedHomeFiles(home: string, files: Readonly<Record<string, string>>): void {
  for (const [relative, base64] of Object.entries(files)) {
    const path = resolveHomePath(home, relative)

    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, Buffer.from(base64, 'base64'), { mode: 0o600 })
    chmodSync(path, 0o600)
  }
}

/** Reads the files that exist among `paths`, as base64 keyed by home-relative path. */
export function collectHomeFiles(home: string, paths: readonly string[]): Record<string, string> {
  const files: Record<string, string> = {}

  for (const relative of paths) {
    const path = resolveHomePath(home, relative)

    if (existsSync(path)) {
      files[relative] = readFileSync(path).toString('base64')
    }
  }

  return files
}

/** Parent directory of an absolute path, or null for `/` / bare filename. */
export function parentDirectory(path: string): string | null {
  const trimmed = path.replace(/\/+$/, '')
  const slash = trimmed.lastIndexOf('/')

  if (slash <= 0) {
    return null
  }

  return trimmed.slice(0, slash)
}

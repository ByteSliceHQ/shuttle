/**
 * Matching for quick file search: the letters typed must appear in the path in order, and paths
 * where they land in the file's name, at the start of a word, or next to each other rank higher.
 * It is the behaviour people expect from an editor's "go to file".
 */

const SEPARATORS = new Set(['/', '.', '-', '_', ' '])

/**
 * Scores `needle` as letters found in order in `haystack`, or null when they are not all there.
 * Letters score more for carrying straight on from the one before, for starting a word, and for
 * sitting at or after `nameStart`.
 */
function inOrderScore(needle: string, haystack: string, nameStart: number): number | null {
  const atWordStart = (at: number) => at === 0 || SEPARATORS.has(haystack[at - 1] ?? '')

  /** Whether `needle` from letter `letter` on can still be found in order from `start`. */
  const restFits = (letter: number, start: number) => {
    let at = start

    for (let index = letter; index < needle.length; index++) {
      at = haystack.indexOf(needle[index] ?? '', at) + 1

      if (at === 0) {
        return false
      }
    }

    return true
  }

  if (!restFits(0, 0)) {
    return null
  }

  let score = 0
  let from = 0
  let previous = -2

  for (let index = 0; index < needle.length; index++) {
    const letter = needle[index] ?? ''
    const next = haystack.indexOf(letter, from)
    let at = next

    // Carrying straight on from the last letter is best; failing that, the start of a later
    // word, which is how initials ("ssh" for session-share) are meant.
    if (next !== previous + 1) {
      for (let seek = next; seek >= 0; seek = haystack.indexOf(letter, seek + 1)) {
        if (atWordStart(seek) && restFits(index + 1, seek + 1)) {
          at = seek
          break
        }
      }
    }

    score +=
      1 + (at === previous + 1 ? 6 : 0) + (atWordStart(at) ? 8 : 0) + (at >= nameStart ? 4 : 0)

    previous = at
    from = at + 1
  }

  return score
}

/**
 * How well `query` matches `path`: higher is better, null is no match. An empty query matches
 * everything equally.
 */
export function matchScore(query: string, path: string): number | null {
  const needle = query.toLowerCase().replaceAll(/\s+/g, '')

  if (!needle) {
    return 0
  }

  const haystack = path.toLowerCase()
  const nameStart = haystack.lastIndexOf('/') + 1

  // The whole query inside the file's name is what people most often mean.
  const inName = haystack.indexOf(needle, nameStart)

  if (inName >= 0) {
    return 1000 - (inName - nameStart) * 2 - (haystack.length - nameStart - needle.length)
  }

  // Next best is every letter within the name; then letters anywhere along the path.
  const withinName = inOrderScore(needle, haystack.slice(nameStart), 0)
  const alongPath = inOrderScore(needle, haystack, nameStart)

  if (withinName === null && alongPath === null) {
    return null
  }

  // Among equal matches the shorter path is the likelier one.
  return (
    Math.max(withinName === null ? 0 : withinName + 100, alongPath ?? 0) - haystack.length / 100
  )
}

/** The paths that match `query`, best first, at most `limit` of them. */
export function searchFiles(paths: readonly string[], query: string, limit = 50): string[] {
  const scored = []

  for (const path of paths) {
    const score = matchScore(query, path)

    if (score !== null) {
      scored.push({ path, score })
    }
  }

  return scored
    .toSorted((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, limit)
    .map((item) => item.path)
}

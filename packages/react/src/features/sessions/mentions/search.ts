/**
 * Finding what was typed after `@` in the message box, and searching a session's paths for it.
 *
 * The paths are read once per session and searched here, on every keystroke, so the search has
 * to stay fast on repositories with tens of thousands of files. Each path is lowercased once, a
 * query that extends the last one only searches what the last one matched, and only the best few
 * are sorted.
 */

/** The `@…` being typed: where the `@` is and what follows it, up to the caret. */
export interface MentionQuery {
  readonly start: number
  readonly query: string
}

/** Longest `@…` the menu keeps searching for, in characters. */
const MAX_QUERY = 80

/**
 * The mention the caret is in, if any. An `@` counts at the start of the text or after a space or
 * line break, so an email address is not one. What follows it runs to the caret: single spaces
 * are allowed, so a session can be found by more than one word of its title, but a line break,
 * two spaces in a row or a space straight after the `@` end it. Whether anything still matches
 * is the menu's to say.
 */
export function findMentionQuery(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')

  if (at === -1) {
    return null
  }

  const query = before.slice(at + 1)

  if (query.length > MAX_QUERY || /^\s|\s\s|[\n\r\t]/.test(query)) {
    return null
  }

  const previous = at === 0 ? '' : before.charAt(at - 1)

  return previous === '' || /\s/.test(previous) ? { start: at, query } : null
}

/** The message box's text after a pick, and where its caret goes. */
export interface MentionInsertion {
  readonly text: string
  readonly caret: number
}

/** `text` with the mention at `mention` replaced by `token` and a space, and where the caret goes. */
export function insertMention(
  text: string,
  mention: MentionQuery,
  token: string,
): MentionInsertion {
  const end = mention.start + 1 + mention.query.length
  const after = text.slice(end)
  const inserted = `${token}${after.startsWith(' ') ? '' : ' '}`

  return {
    text: `${text.slice(0, mention.start)}${inserted}${after}`,
    caret: mention.start + inserted.length + (after.startsWith(' ') ? 1 : 0),
  }
}

const SEPARATORS = new Set(['/', '.', '-', '_', ' '])

/**
 * How well `query` (lowercase) matches `path` (lowercase), or -1 when it does not: every character
 * of the query has to appear in order. A match in the file's own name beats one in its folders,
 * a run of characters beats scattered ones, a character at the start of a word counts extra, and a
 * shorter path wins a tie.
 */
export function scorePath(query: string, path: string): number {
  if (query === '') {
    return 0
  }

  const slash = path.lastIndexOf('/')
  const name = path.slice(slash + 1)
  const inName = name.indexOf(query)

  // The common case: the file's name holds what was typed.
  if (inName !== -1) {
    return 1_000 + (inName === 0 ? 200 : 0) + (name.length === query.length ? 300 : 0) - path.length
  }

  const inPath = path.indexOf(query)

  if (inPath !== -1) {
    const atWord = inPath === 0 || SEPARATORS.has(path.charAt(inPath - 1))

    return 600 + (atWord ? 100 : 0) - path.length
  }

  // Scattered: the characters in order, scored by where they land.
  let score = 0
  let from = 0
  let previous = -2

  for (const char of query) {
    const found = path.indexOf(char, from)

    if (found === -1) {
      return -1
    }

    score += 1
    score += found === previous + 1 ? 5 : 0
    score += found === 0 || SEPARATORS.has(path.charAt(found - 1)) ? 8 : 0
    score += found > slash ? 3 : 0
    previous = found
    from = found + 1
  }

  return score - path.length / 10
}

export interface PathMatch {
  readonly path: string
  readonly score: number
}

/**
 * A searchable list of paths. Made once per list; `search` remembers its last query, so typing
 * one more character only looks at what already matched.
 */
export class PathIndex {
  private readonly lower: readonly string[]
  private lastQuery = ''
  private lastHits: readonly number[] | null = null

  constructor(readonly paths: readonly string[]) {
    this.lower = paths.map((path) => path.toLowerCase())
  }

  get size(): number {
    return this.paths.length
  }

  search(rawQuery: string, limit: number): PathMatch[] {
    const query = rawQuery.toLowerCase()

    if (query === '') {
      return []
    }

    // Typing one more character can only lose matches, so only the last ones are looked at.
    const narrowing = this.lastQuery !== '' && query.startsWith(this.lastQuery)
    const candidates = narrowing ? this.lastHits : null

    const hits: number[] = []
    // The best `limit` so far, best first. A query of one letter matches nearly every path, so
    // only these few are kept in order, not all of them sorted.
    const best: { index: number; score: number }[] = []

    const consider = (index: number) => {
      const score = scorePath(query, this.lower[index] ?? '')

      if (score < 0) {
        return
      }

      hits.push(index)

      const worst = best.at(-1)

      if (best.length >= limit && worst !== undefined && score <= worst.score) {
        return
      }

      // After every match that scores the same or better, so a tie keeps the list's order.
      let at = best.length

      while (at > 0 && (best[at - 1]?.score ?? 0) < score) {
        at -= 1
      }

      best.splice(at, 0, { index, score })

      if (best.length > limit) {
        best.pop()
      }
    }

    if (candidates === null) {
      for (let index = 0; index < this.lower.length; index++) {
        consider(index)
      }
    } else {
      for (const index of candidates) {
        consider(index)
      }
    }

    this.lastQuery = query
    this.lastHits = hits

    return best.map(({ index, score }) => ({ path: this.paths[index] ?? '', score }))
  }
}

/**
 * How well `query` (as typed) matches a label, for the short lists: agents and sessions, or -1
 * when it does not. Titles are sentences, where letters scattered across them match almost
 * anything, so the query has to be the title, start it, start one of its words, appear in it, or
 * be the first letters of its words in order ("bta" for "Build a todo app"); in that order of how
 * well it matches. Labels that match equally well score the same, for the caller to order.
 */
export function scoreLabel(query: string, label: string): number {
  const typed = query.toLowerCase()

  if (typed === '') {
    return 0
  }

  const text = label.toLowerCase()
  const at = text.indexOf(typed)

  if (text === typed) {
    return 500
  }

  if (at === 0) {
    return 400
  }

  if (at > 0) {
    // At the start of a later word, or anywhere in one.
    return /[\s/._-]/.test(text.charAt(at - 1)) ? 300 : 200
  }

  const initials = text
    .split(/[\s/._-]+/)
    .filter((word) => word !== '')
    .map((word) => word.charAt(0))
    .join('')

  return typed.length > 1 && scorePath(typed, initials) >= 0 ? 100 : -1
}

/** Whether `query` (as typed) matches a label at all; see `scoreLabel`. */
export function matchesLabel(query: string, label: string): boolean {
  return scoreLabel(query, label) >= 0
}

/** Longest a session's label is in the menu and in the message, in characters. */
const MAX_LABEL = 80

/**
 * How a session is written after `@`: the first line of its title (or goal, when it has none),
 * cut short. A goal can run to paragraphs, which a message should not have to carry.
 */
export function sessionLabel(title: string, goal: string): string {
  const line = (title.trim() === '' ? goal : title).trim().split('\n')[0]?.trim() ?? ''

  return line.length > MAX_LABEL ? `${line.slice(0, MAX_LABEL - 1).trimEnd()}…` : line
}

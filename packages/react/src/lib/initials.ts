const SUFFIXES = new Set(['jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv', 'phd', 'md'])
const EMOJI = /\p{Extended_Pictographic}/u

/** The first user-perceived character of a word, so an emoji or accented letter stays whole. */
function firstGrapheme(word: string): string {
  if ('Segmenter' in Intl) {
    const [first] = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(word)

    return first?.segment ?? ''
  }

  return Array.from(word)[0] ?? ''
}

/**
 * Up to two initials for a person: the first and last word of their name, leaving out suffixes
 * such as "III". A name that starts with an emoji is shown as that emoji alone, and a name that
 * is only an email address uses the part before the `@`. Returns nothing when there is no name.
 */
export function initials(name: string | undefined): string {
  const trimmed = (name ?? '').trim()
  const source = trimmed.includes('@') ? (trimmed.split('@')[0] ?? '') : trimmed
  // An address has no spaces, so its dots and dashes are what separate the words.
  const words = source.split(trimmed.includes('@') ? /[\s._-]+/ : /\s+/).filter(Boolean)

  const meaningful =
    words.length > 1 ? words.filter((word) => !SUFFIXES.has(word.toLowerCase())) : words

  const first = meaningful[0]
  const last = meaningful.length > 1 ? meaningful.at(-1) : undefined

  if (first === undefined || first === '') {
    return ''
  }

  const lead = firstGrapheme(first)

  if (EMOJI.test(lead)) {
    return lead
  }

  return `${lead}${last !== undefined && last !== '' ? firstGrapheme(last) : ''}`.toLocaleUpperCase()
}

const WORD_BREAKS = /[\s\-_/:]+/

const compact = (text: string) => text.replace(/[\s\-_/.:]+/g, '')

/**
 * Whether a model matches what was typed into the picker's search. Every word must appear in one
 * of the fields, in any order, so "opus max" finds "Claude Opus 4.8 1M Max Thinking" and
 * "gpt5" finds "gpt-5.6-sol".
 */
export function matchesModelQuery(query: string, fields: readonly (string | undefined)[]): boolean {
  const words = query.toLowerCase().split(WORD_BREAKS).filter(Boolean)

  if (words.length === 0) {
    return true
  }

  const text = fields.filter(Boolean).join(' ').toLowerCase()
  const squeezed = compact(text)

  return words.every((word) => text.includes(word) || squeezed.includes(compact(word)))
}

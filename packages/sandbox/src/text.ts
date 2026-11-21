/** The text, or undefined when it is missing or empty. */
export function nonEmpty(value: string | null | undefined): string | undefined {
  return value === null || value === undefined || value === '' ? undefined : value
}

/** The text, or `fallback` when it is empty. */
export function orElse(text: string, fallback: string): string {
  return text === '' ? fallback : text
}

/** The text, or null when it is empty. */
export function nullIfEmpty(text: string): string | null {
  return text === '' ? null : text
}
